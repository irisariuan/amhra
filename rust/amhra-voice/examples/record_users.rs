//! Join a voice channel, listen, and write what each person said to a WAV file.
//!
//! This is the receive path's gate, as `play_file` was the send path's: if a
//! file comes out of this with someone's voice in it, then SSRC attribution,
//! transport decryption, DAVE decryption under that member's key and Opus
//! decoding are all right.
//!
//! ```text
//! cargo run --release -p amhra-voice --example record_users -- \
//!     --guild <GUILD_ID> --channel <VOICE_CHANNEL_ID> --seconds 30 --out recordings
//! ```
//!
//! with `DEV_TOKEN` in the environment. Talk in the channel while it runs. One
//! `<user id>.wav` per speaker lands in `--out`: 16 kHz, mono, 16-bit, which is
//! what speech recognition will be fed. Only speech is written — the quiet
//! between bursts is not sent by Discord, so it is not in the file either.
//!
//! `--keep-gaps` puts that quiet back as silence, so each file runs in real
//! time from the speaker's first word. That is what the voice-command harness
//! (`amhra-sidecar`'s `wake_wav` example) needs: it ends a command on half a
//! second of silence, and without the gaps there is none.
//!
//! Like `play_file`, it speaks just enough of the main gateway to join; the
//! real bot gets those four values from discord.js.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use amhra_voice::dave::driver::{Action, Driver};
use amhra_voice::gateway::{ConnectionInfo, Event, GatewayHandle};
use amhra_voice::receive::{Listener, Membership, SAMPLE_RATE, VoiceFrame};
use amhra_voice::wire::EncryptionMode;
use amhra_voice::{Opener, Session, VoiceUdp};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

const MAIN_GATEWAY: &str = "wss://gateway.discord.gg/?v=10&encoding=json";
/// GUILDS | GUILD_VOICE_STATES — the minimum to be told about our own move.
const INTENTS: u32 = (1 << 0) | (1 << 7);
const MAX_DAVE_VERSION: u8 = 1;

struct Args {
	token: String,
	guild: String,
	channel: String,
	seconds: u64,
	out: std::path::PathBuf,
	keep_gaps: bool,
}

fn args() -> Args {
	let (mut token, mut guild, mut channel) = (None, None, None);
	let mut seconds = 30;
	let mut out = std::path::PathBuf::from("recordings");
	let mut keep_gaps = false;
	let mut argv = std::env::args().skip(1);
	while let Some(arg) = argv.next() {
		let mut value = || argv.next().expect("option needs a value");
		match arg.as_str() {
			"--token" => token = Some(value()),
			"--guild" => guild = Some(value()),
			"--channel" => channel = Some(value()),
			"--seconds" => seconds = value().parse().expect("--seconds takes a number"),
			"--out" => out = value().into(),
			"--keep-gaps" => keep_gaps = true,
			other => panic!("unknown option {other}"),
		}
	}
	let token = token
		.or_else(|| std::env::var("DEV_TOKEN").ok())
		.or_else(|| std::env::var("DISCORD_TOKEN").ok())
		.filter(|token| !token.is_empty());
	Args {
		token: token.expect("--token, or DEV_TOKEN in the environment"),
		guild: guild.expect("--guild"),
		channel: channel.expect("--channel"),
		seconds,
		out,
		keep_gaps,
	}
}

/// Learn endpoint, token, session id and user id from the main gateway.
///
/// The same dance as `play_file`, except the bot joins undeafened: a deafened
/// client is sent no audio at all.
async fn negotiate(args: &Args) -> ConnectionInfo {
	let (mut socket, _) = tokio_tungstenite::connect_async(MAIN_GATEWAY).await.expect("gateway");

	let mut user_id = String::new();
	let mut session_id = String::new();
	let mut endpoint = String::new();
	let mut voice_token = String::new();
	let mut heartbeat: Option<tokio::time::Interval> = None;
	let mut sequence: Option<u64> = None;
	let mut asked_to_join = false;

	loop {
		tokio::select! {
			_ = async { heartbeat.as_mut().expect("started").tick().await }, if heartbeat.is_some() => {
				let payload = json!({ "op": 1, "d": sequence });
				socket.send(Message::Text(payload.to_string().into())).await.expect("heartbeat");
			}
			message = socket.next() => {
				let Some(Ok(Message::Text(text))) = message else { continue };
				let frame: Value = serde_json::from_str(&text).expect("json");
				if let Some(seq) = frame.get("s").and_then(Value::as_u64) {
					sequence = Some(seq);
				}
				match frame.get("op").and_then(Value::as_u64) {
					Some(10) => {
						let interval = frame
							.pointer("/d/heartbeat_interval")
							.and_then(Value::as_f64)
							.unwrap_or(41_250.0);
						let mut timer = tokio::time::interval(Duration::from_secs_f64(interval / 1000.0));
						timer.tick().await;
						heartbeat = Some(timer);
						let identify = json!({
							"op": 2,
							"d": {
								"token": args.token,
								"intents": INTENTS,
								"properties": { "os": "linux", "browser": "amhra", "device": "amhra" }
							}
						});
						socket.send(Message::Text(identify.to_string().into())).await.expect("identify");
					}
					Some(0) => match frame.get("t").and_then(Value::as_str) {
						Some("READY") => {
							user_id = frame
								.pointer("/d/user/id")
								.and_then(Value::as_str)
								.expect("own user id")
								.to_owned();
							println!("logged in as {user_id}, joining channel…");
							let join = json!({
								"op": 4,
								"d": {
									"guild_id": args.guild,
									"channel_id": args.channel,
									"self_mute": false,
									"self_deaf": false,
								}
							});
							socket.send(Message::Text(join.to_string().into())).await.expect("join");
							asked_to_join = true;
						}
						Some("VOICE_STATE_UPDATE") if asked_to_join => {
							if frame.pointer("/d/user_id").and_then(Value::as_str) == Some(user_id.as_str()) {
								session_id = frame
									.pointer("/d/session_id")
									.and_then(Value::as_str)
									.unwrap_or_default()
									.to_owned();
							}
						}
						Some("VOICE_SERVER_UPDATE") if asked_to_join => {
							endpoint = frame
								.pointer("/d/endpoint")
								.and_then(Value::as_str)
								.unwrap_or_default()
								.to_owned();
							voice_token = frame
								.pointer("/d/token")
								.and_then(Value::as_str)
								.unwrap_or_default()
								.to_owned();
						}
						_ => {}
					},
					_ => {}
				}
			}
		}

		if !session_id.is_empty() && !endpoint.is_empty() && !voice_token.is_empty() {
			// Closing the main gateway drops the voice state, so it is leaked
			// deliberately for the run.
			std::mem::forget(socket);
			return ConnectionInfo {
				endpoint,
				guild_id: args.guild.clone(),
				user_id,
				session_id,
				token: voice_token,
				max_dave_protocol_version: MAX_DAVE_VERSION,
			};
		}
	}
}

async fn perform(handle: &GatewayHandle, action: Action) {
	match action {
		Action::Binary { opcode, payload } => handle.send_binary(opcode, payload).await,
		Action::Transition { opcode, transition_id } => {
			handle.send_json(opcode, json!({ "transition_id": transition_id })).await
		}
	}
}

/// Read from the socket once it exists; until then, never.
async fn recv(udp: Option<&VoiceUdp>, buffer: &mut [u8]) -> Option<usize> {
	match udp {
		Some(udp) => udp.recv(buffer).await.ok(),
		None => std::future::pending().await,
	}
}

/// Announce ourselves on the media path with a few frames of silence.
///
/// Not known to be required for receiving, but it is what every client does
/// on joining, and it costs nothing to rule out as a cause.
async fn prime(handle: &GatewayHandle, udp: &VoiceUdp, session: &mut Session, dave: Option<&Mutex<Driver>>) {
	handle.set_speaking(true).await;
	let (mut framed, mut packet) = (Vec::new(), Vec::new());
	for _ in 0..5 {
		let payload: &[u8] = match dave {
			Some(dave) => {
				let mut driver = dave.lock().expect("dave lock");
				if driver.encrypting() && driver.encrypt_opus(&amhra_voice::SILENCE_FRAME, &mut framed).is_ok() {
					&framed
				} else {
					&amhra_voice::SILENCE_FRAME
				}
			}
			None => &amhra_voice::SILENCE_FRAME,
		};
		session.seal(payload, &mut packet).expect("seal silence");
		let _ = udp.send(&packet).await;
		session.advance(960);
		tokio::time::sleep(Duration::from_millis(20)).await;
	}
	handle.set_speaking(false).await;
}

/// 16-bit PCM mono at [`SAMPLE_RATE`], with the canonical 44-byte header.
fn write_wav(path: &std::path::Path, samples: &[i16]) -> std::io::Result<()> {
	let data_len = (samples.len() * 2) as u32;
	let mut bytes = Vec::with_capacity(44 + data_len as usize);
	bytes.extend_from_slice(b"RIFF");
	bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
	bytes.extend_from_slice(b"WAVEfmt ");
	bytes.extend_from_slice(&16u32.to_le_bytes());
	bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
	bytes.extend_from_slice(&1u16.to_le_bytes()); // mono
	bytes.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
	bytes.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
	bytes.extend_from_slice(&2u16.to_le_bytes());
	bytes.extend_from_slice(&16u16.to_le_bytes());
	bytes.extend_from_slice(b"data");
	bytes.extend_from_slice(&data_len.to_le_bytes());
	for sample in samples {
		bytes.extend_from_slice(&sample.to_le_bytes());
	}
	std::fs::write(path, bytes)
}

#[tokio::main]
async fn main() {
	amhra_voice::gateway::install_default_crypto_provider();
	let args = args();
	let info = negotiate(&args).await;
	println!("voice endpoint {} (session {})", info.endpoint, info.session_id);
	let user_id: u64 = info.user_id.parse().expect("user id is numeric");
	let channel_id: u64 = args.channel.parse().expect("channel id is numeric");

	let (handle, mut events) = amhra_voice::gateway::connect(info);
	let mut udp: Option<VoiceUdp> = None;
	let mut ssrc = 0u32;
	let mut session: Option<Session> = None;
	let mut dave: Option<Mutex<Driver>> = None;
	let mut listener: Option<Listener> = None;
	// SSRCs announced before the listener existed.
	let mut early: Vec<Membership> = Vec::new();
	let mut primed = false;
	let mut recordings: HashMap<u64, Vec<i16>> = HashMap::new();
	let mut first_heard: HashMap<u64, Instant> = HashMap::new();
	let keep_gaps = args.keep_gaps;
	let mut record = |frame: VoiceFrame| {
		let samples = recordings.entry(frame.user_id).or_default();
		if keep_gaps {
			// Where this frame belongs by the clock, measured from their first.
			let first = *first_heard.entry(frame.user_id).or_insert_with(Instant::now);
			let due = (first.elapsed().as_secs_f64() * f64::from(SAMPLE_RATE)) as usize;
			let start = due.saturating_sub(frame.pcm.len());
			// A few frames late is arrival jitter, not someone pausing.
			if start > samples.len() + 3 * frame.pcm.len() {
				samples.resize(start, 0);
			}
		}
		samples.extend(frame.pcm);
	};

	let mut buffer = [0u8; 2048];
	let mut deadline: Option<Instant> = None;
	let mut tick = tokio::time::interval(Duration::from_secs(1));

	loop {
		tokio::select! {
			_ = tick.tick() => {
				if let Some(listener) = listener.as_mut() {
					listener.expire(Instant::now());
				}
				if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
					println!("stopping at the {}s limit", args.seconds);
					break;
				}
			}

			length = recv(udp.as_ref(), &mut buffer) => {
				let (Some(length), Some(listener)) = (length, listener.as_mut()) else { continue };
				listener.handle_packet(&buffer[..length], Instant::now(), dave.as_ref(), &mut record);
			}

			event = events.recv() => {
				let Some(event) = event else { break };
				match event {
					Event::Ready { ssrc: theirs, ip, port, modes } => {
						ssrc = theirs;
						let mode = EncryptionMode::negotiate(&modes).expect("a supported cipher");
						println!("ready: ssrc {ssrc}, {ip}:{port}, using {}", mode.as_str());
						let remote = format!("{ip}:{port}").parse().expect("voice server address");
						let socket = VoiceUdp::connect(remote).await.expect("udp connect");
						let found = socket.discover(ssrc).await.expect("ip discovery");
						handle.select_protocol(found.address, found.port, mode.as_str().to_owned()).await;
						udp = Some(socket);
					}
					Event::SessionDescription { mode, secret_key, dave_protocol_version } => {
						println!("session description: mode {mode}, dave version {dave_protocol_version}");
						let mode = EncryptionMode::parse(&mode).expect("negotiated cipher is known");
						session = Some(Session::new(mode, &secret_key, ssrc).expect("32-byte key"));
						let mut fresh = Listener::new(Opener::new(mode, &secret_key).expect("32-byte key"), ssrc);
						if dave_protocol_version > 0 {
							let mut driver = Driver::new(dave_protocol_version, user_id, channel_id)
								.expect("dave session");
							for action in driver.start().expect("key package") {
								perform(&handle, action).await;
							}
							dave = Some(Mutex::new(driver));
						}
						for change in early.drain(..) {
							fresh.membership(change, Instant::now(), dave.as_ref(), &mut record);
						}
						listener = Some(fresh);
						deadline = Some(Instant::now() + Duration::from_secs(args.seconds));
						println!("listening for {}s — talk now", args.seconds);
					}
					Event::Dave { opcode, data, payload } => {
						let Some(driver) = dave.as_ref() else { continue };
						let (actions, ready, members) = {
							let mut driver = driver.lock().expect("dave lock");
							let actions = driver.handle(opcode, &data, &payload).unwrap_or_else(|error| {
								eprintln!("dave {opcode:?} failed: {error}");
								Vec::new()
							});
							(actions, driver.is_ready(), driver.session().member_ids())
						};
						for action in actions {
							perform(&handle, action).await;
						}
						if ready {
							println!("dave epoch moved: members {members:?}");
						}
					}
					Event::Speaking { user_id: speaker, ssrc: theirs, flags } => {
						println!("speaking: user {speaker} is ssrc {theirs} (flags {flags})");
						let change = Membership::Speaking { user_id: speaker, ssrc: theirs };
						match listener.as_mut() {
							Some(listener) => listener.membership(change, Instant::now(), dave.as_ref(), &mut record),
							None => early.push(change),
						}
					}
					Event::ClientDisconnect { user_id: gone } => {
						println!("user {gone} left");
						let change = Membership::Disconnect { user_id: gone };
						match listener.as_mut() {
							Some(listener) => listener.membership(change, Instant::now(), dave.as_ref(), &mut record),
							None => early.push(change),
						}
					}
					Event::Closed(reason) => {
						eprintln!("gateway closed: {reason}");
						break;
					}
					other => println!("{other:?}"),
				}
			}
		}

		// Once the call can carry audio, say hello on it once.
		let can_send = dave.as_ref().is_none_or(|driver| driver.lock().is_ok_and(|d| d.can_send()));
		if !primed && can_send && let (Some(socket), Some(session)) = (udp.as_ref(), session.as_mut()) {
			prime(&handle, socket, session, dave.as_ref()).await;
			primed = true;
		}
	}

	handle.close().await;
	if let Some(listener) = &listener {
		for (user, stats) in listener.stats() {
			println!("user {user}: {stats:?}");
		}
		let (failures, dropped) = listener.unattributed();
		println!("unattributed: {failures} undecryptable, {dropped} unclaimed");
	}

	std::fs::create_dir_all(&args.out).expect("output directory");
	if recordings.is_empty() {
		println!("nobody was heard");
	}
	for (user, samples) in &recordings {
		let path = args.out.join(format!("{user}.wav"));
		write_wav(&path, samples).expect("write wav");
		println!(
			"wrote {} ({:.1}s)",
			path.display(),
			samples.len() as f64 / f64::from(SAMPLE_RATE)
		);
	}
}
