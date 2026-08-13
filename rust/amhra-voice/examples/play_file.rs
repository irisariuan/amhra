//! Join a voice channel and play a cached track.
//!
//! This is the phase-2 gate: if audio comes out of this, the gateway, the UDP
//! transport, the RTP framing and the transport encryption are all correct, and
//! everything after it is ordinary engineering.
//!
//! ```text
//! cargo run --release -p amhra-voice --example play_file -- \
//!     --token <BOT_TOKEN> --guild <GUILD_ID> --channel <VOICE_CHANNEL_ID> \
//!     --file ../cache/<id>.music
//! ```
//!
//! The bot must already be in the guild and able to join that channel. Put a
//! second account in the channel to listen.
//!
//! It speaks just enough of the main gateway to learn the four things the voice
//! gateway needs — endpoint, token, session id and user id — which in the real
//! bot come from discord.js instead.

use std::time::{Duration, Instant};

use amhra_audio::{WebmDemuxer, packet_info};
use amhra_voice::dave::driver::{Action, Driver};
use amhra_voice::gateway::{ConnectionInfo, Event};
use amhra_voice::wire::EncryptionMode;
use amhra_voice::{Session, VoiceUdp};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

const MAIN_GATEWAY: &str = "wss://gateway.discord.gg/?v=10&encoding=json";
/// GUILDS | GUILD_VOICE_STATES — the minimum to be told about our own move.
const INTENTS: u32 = (1 << 0) | (1 << 7);
/// Advertised DAVE support. Measured 2026-08-13: advertising 0 is closed with
/// 4017 before the session opens, so end-to-end encryption is not optional.
const MAX_DAVE_VERSION: u8 = 1;

struct Args {
	token: String,
	guild: String,
	channel: String,
	file: String,
	/// Stop after this many seconds. Absent plays the whole track.
	seconds: Option<u64>,
	/// Filled in from the main gateway's READY.
	user_id: String,
}

fn args() -> Args {
	let (mut token, mut guild, mut channel, mut file) = (None, None, None, None);
	let mut seconds = None;
	let mut argv = std::env::args().skip(1);
	while let Some(arg) = argv.next() {
		let mut value = || argv.next().expect("option needs a value");
		match arg.as_str() {
			"--token" => token = Some(value()),
			"--guild" => guild = Some(value()),
			"--channel" => channel = Some(value()),
			"--file" => file = Some(value()),
			"--seconds" => seconds = Some(value().parse().expect("--seconds takes a number")),
			other => panic!("unknown option {other}"),
		}
	}
	// Reading the token from the environment keeps it out of the process list
	// and out of shell history.
	let token = token
		.or_else(|| std::env::var("DEV_TOKEN").ok())
		.or_else(|| std::env::var("DISCORD_TOKEN").ok())
		.filter(|token| !token.is_empty());

	Args {
		token: token.expect("--token, or DEV_TOKEN in the environment"),
		guild: guild.expect("--guild"),
		channel: channel.expect("--channel"),
		file: file.expect("--file"),
		seconds,
		user_id: String::new(),
	}
}

/// Read every Opus packet out of a `.music` file.
///
/// The whole file is demuxed up front here — a few milliseconds, and it keeps
/// the example about the voice protocol rather than about streaming. The real
/// player follows a file still being written and seeks through the `.idx`.
fn load_frames(path: &str) -> (Vec<u8>, Vec<(usize, usize, u32)>) {
	let bytes = std::fs::read(path).expect("read cache file");
	let mut demuxer = WebmDemuxer::new();
	let mut frames = Vec::new();
	demuxer
		.feed(&bytes, &mut |frame| {
			frames.push((frame.offset as usize, frame.len as usize, frame.duration_us));
		})
		.expect("file is WebM/Opus");
	(bytes, frames)
}

/// Learn endpoint, token, session id and user id from the main gateway.
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
				socket.send(Message::Text(payload.to_string())).await.expect("heartbeat");
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
						socket.send(Message::Text(identify.to_string())).await.expect("identify");
					}
					Some(0) => {
						match frame.get("t").and_then(Value::as_str) {
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
										"self_deaf": true,
									}
								});
								socket.send(Message::Text(join.to_string())).await.expect("join");
								asked_to_join = true;
							}
							Some("VOICE_STATE_UPDATE") if asked_to_join => {
								// Only our own move carries the session we need.
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
						}
					}
					_ => {}
				}
			}
		}

		if !session_id.is_empty() && !endpoint.is_empty() && !voice_token.is_empty() {
			// The main gateway connection has to stay open: closing it drops the
			// voice state, so it is leaked deliberately for the run.
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

#[tokio::main]
async fn main() {
	// The main-gateway connection here happens before any voice code runs, so
	// the provider has to be chosen before it rather than inside `connect`.
	amhra_voice::gateway::install_default_crypto_provider();

	let mut args = args();
	let (audio, frames) = load_frames(&args.file);
	println!("{} frames loaded from {}", frames.len(), args.file);

	let info = negotiate(&args).await;
	args.user_id = info.user_id.clone();
	println!("voice endpoint {} (session {})", info.endpoint, info.session_id);

	let (handle, mut events) = amhra_voice::gateway::connect(info);

	let mut udp: Option<VoiceUdp> = None;
	let mut ssrc = 0u32;
	let mut session: Option<Session> = None;
	let mut dave: Option<Driver> = None;
	let user_id: u64 = args.user_id.parse().expect("user id is numeric");
	let channel_id: u64 = args.channel.parse().expect("channel id is numeric");

	while let Some(event) = events.recv().await {
		match event {
			Event::Ready { ssrc: their_ssrc, ip, port, modes } => {
				ssrc = their_ssrc;
				let mode = EncryptionMode::negotiate(&modes).expect("a supported cipher");
				println!("ready: ssrc {ssrc}, {ip}:{port}, using {}", mode.as_str());

				let remote = format!("{ip}:{port}").parse().expect("voice server address");
				let socket = VoiceUdp::connect(remote).await.expect("udp connect");
				let found = socket.discover(ssrc).await.expect("ip discovery");
				println!("discovered {}:{}", found.address, found.port);

				handle.select_protocol(found.address, found.port, mode.as_str().to_owned()).await;
				udp = Some(socket);
			}
			Event::SessionDescription { mode, secret_key, dave_protocol_version } => {
				println!(
					"session description: mode {mode}, dave version {dave_protocol_version}"
				);
				if dave_protocol_version == 0 {
					println!("!! server did not negotiate DAVE; frames will be sent in the clear");
				}

				let mode = EncryptionMode::parse(&mode).expect("negotiated cipher is known");
				session = Some(Session::new(mode, &secret_key, ssrc).expect("32-byte key"));
				if dave_protocol_version > 0 {
					let mut driver = Driver::new(dave_protocol_version, user_id, channel_id)
						.expect("dave session");
					// The server will not announce anything until it has our key
					// package, so it goes out immediately.
					for action in driver.start().expect("key package") {
						if let Action::Binary { opcode, payload } = action {
							handle.send_binary(opcode, payload).await;
						}
					}
					println!("dave v{dave_protocol_version}: key package sent, joining group…");
					dave = Some(driver);
					continue;
				}
				break;
			}
			Event::Closed(reason) => {
				eprintln!("gateway closed before we could play: {reason}");
				return;
			}
			Event::Dave { opcode, data, payload } => {
				let Some(driver) = dave.as_mut() else { continue };
				println!("dave <- {opcode:?} ({} bytes)", payload.len());
				match driver.handle(opcode, &data, &payload) {
					Ok(actions) => {
						for action in actions {
							match action {
								Action::Binary { opcode, payload } => {
									handle.send_binary(opcode, payload).await
								}
								Action::Transition { opcode, transition_id } => {
									handle
										.send_json(
											opcode,
											serde_json::json!({ "transition_id": transition_id }),
										)
										.await
								}
							}
						}
					}
					Err(error) => eprintln!("dave {opcode:?} failed: {error}"),
				}
				if driver.is_ready() {
					println!(
						"dave group ready: epoch {:?}, members {:?}",
						driver.session().epoch(),
						driver.session().member_ids()
					);
					break;
				}
			}
			Event::Reconnecting(reason) => println!("reconnecting: {reason}"),
			other => println!("{other:?}"),
		}
	}

	let (Some(udp), Some(mut session)) = (udp, session) else {
		eprintln!("never reached a playable state");
		return;
	};

	// Every frame is DAVE-encrypted before the transport seals it, so the voice
	// server relays ciphertext it cannot read.
	let mut e2ee = Vec::with_capacity(1400);
	let mut encrypt = move |opus: &[u8], dave: &mut Option<Driver>| -> Vec<u8> {
		match dave {
			Some(driver) => {
				driver.encrypt_opus(opus, &mut e2ee).expect("dave encrypt");
				e2ee.clone()
			}
			None => opus.to_vec(),
		}
	};

	handle.set_speaking(true).await;
	// Discord drops the first moments after a speaking change often enough that
	// clients conventionally lead with silence.
	let mut packet = Vec::with_capacity(1400);
	for _ in 0..5 {
		session.seal(&amhra_voice::SILENCE_FRAME, &mut packet).expect("seal silence");
		udp.send(&packet).await.expect("send silence");
		session.advance(960);
		tokio::time::sleep(Duration::from_millis(20)).await;
	}

	println!("playing…");
	// Absolute scheduling: sleeping 20ms per frame accumulates every scheduling
	// overshoot into drift, so each frame is timed against the start instead.
	let started = Instant::now();
	let mut elapsed_us = 0u64;
	for (index, (offset, len, duration_us)) in frames.iter().enumerate() {
		let opus = &audio[*offset..*offset + *len];
		let framed = encrypt(opus, &mut dave);
		session.seal(&framed, &mut packet).expect("seal frame");
		udp.send(&packet).await.expect("send frame");

		let samples = packet_info(opus).map_or(960, |info| info.samples());
		session.advance(samples);

		elapsed_us += *duration_us as u64;
		let deadline = Duration::from_micros(elapsed_us);
		if let Some(wait) = deadline.checked_sub(started.elapsed()) {
			tokio::time::sleep(wait).await;
		}
		if index % 500 == 0 {
			println!("  {}s", elapsed_us / 1_000_000);
		}
		if args.seconds.is_some_and(|limit| elapsed_us >= limit * 1_000_000) {
			println!("stopping at the {}s limit", elapsed_us / 1_000_000);
			break;
		}
	}

	for _ in 0..3 {
		session.seal(&amhra_voice::SILENCE_FRAME, &mut packet).expect("seal silence");
		udp.send(&packet).await.expect("send silence");
		session.advance(960);
		tokio::time::sleep(Duration::from_millis(20)).await;
	}
	handle.set_speaking(false).await;
	println!("done after {:?}", started.elapsed());
	handle.close().await;
}
