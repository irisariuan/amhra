//! Join a voice channel and print wake words and commands as they are said.
//!
//! The live counterpart of `wake_wav`: the same receive path as the sidecar
//! (`record_users`' join, `Listener`), feeding the same voice-command engine,
//! with every notice printed instead of turned into protocol events.
//!
//! ```text
//! cargo run --release -p amhra-sidecar --features voice-commands --example wake_live -- \
//!     --guild <GUILD_ID> --channel <VOICE_CHANNEL_ID> --seconds 300
//! ```
//!
//! with `DEV_TOKEN` in the environment, run from the repository root so the
//! default `--models models/voice` and `--keywords data/wake-keywords.txt`
//! resolve. Then say "Amhra, skip this song" in the channel. `--threshold`
//! overrides the keyword threshold for a session of tuning.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use amhra_sidecar::listen::Heard;
use amhra_sidecar::voice_commands::engine::{Engine, Notice};
use amhra_sidecar::voice_commands::gate::GateConfig;
use amhra_sidecar::voice_commands::sherpa::{self, SherpaConfig};
use amhra_voice::dave::driver::{Action, Driver};
use amhra_voice::gateway::{ConnectionInfo, Event, GatewayHandle};
use amhra_voice::receive::{Listener, Membership};
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
	models: std::path::PathBuf,
	keywords: std::path::PathBuf,
	threshold: Option<f32>,
}

fn args() -> Args {
	let (mut token, mut guild, mut channel, mut threshold) = (None, None, None, None);
	let mut seconds = 300;
	let mut models = std::path::PathBuf::from("models/voice");
	let mut keywords = std::path::PathBuf::from("data/wake-keywords.txt");
	let mut argv = std::env::args().skip(1);
	while let Some(arg) = argv.next() {
		let mut value = || argv.next().expect("option needs a value");
		match arg.as_str() {
			"--token" => token = Some(value()),
			"--guild" => guild = Some(value()),
			"--channel" => channel = Some(value()),
			"--seconds" => seconds = value().parse().expect("--seconds takes a number"),
			"--models" => models = value().into(),
			"--keywords" => keywords = value().into(),
			"--threshold" => threshold = Some(value().parse().expect("--threshold takes a number")),
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
		models,
		keywords,
		threshold,
	}
}

/// Print a notice the way a person tuning this wants to read it.
fn print(started: Instant, notice: Notice) {
	let at = started.elapsed().as_secs_f64();
	match notice {
		Notice::Woke { user_id, keyword, .. } => println!("{at:7.1}s  {user_id}: woke on {keyword}"),
		Notice::TimedOut { user_id, keyword, .. } => {
			println!("{at:7.1}s  {user_id}: {keyword}, then nothing")
		}
		Notice::Utterance { user_id, text, lang, latency_ms, recognition_ms, audio_ms, .. } => println!(
			"{at:7.1}s  {user_id}: [{}] {text:?}  ({audio_ms}ms of speech; text {latency_ms}ms after they stopped, {recognition_ms}ms of it recognising)",
			lang.as_deref().unwrap_or("?")
		),
		Notice::Unintelligible { user_id, keyword, .. } => {
			println!("{at:7.1}s  {user_id}: {keyword}, then nothing recognisable")
		}
		Notice::Dropped { what, count, .. } => println!("{at:7.1}s  behind: dropped {count} {what}"),
		Notice::Failed { message, .. } => println!("{at:7.1}s  failed: {message}"),
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
							socket.send(Message::Text(join.to_string())).await.expect("join");
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

#[tokio::main]
async fn main() {
	amhra_voice::gateway::install_default_crypto_provider();
	let args = args();

	let keywords = std::fs::read_to_string(&args.keywords)
		.unwrap_or_else(|error| panic!("{}: {error}", args.keywords.display()));
	let mut config = SherpaConfig::new(args.models.clone(), keywords);
	if let Some(threshold) = args.threshold {
		config.keyword_threshold = threshold;
	}
	let loading = Instant::now();
	let (models, recogniser) = sherpa::load(&config).unwrap_or_else(|error| panic!("{error}"));
	println!("models loaded in {:?}", loading.elapsed());
	let started = Instant::now();
	let engine = Engine::start(
		models,
		Box::new(recogniser),
		GateConfig::default(),
		Arc::new(move |notice| print(started, notice)),
	)
	.expect("recogniser thread");
	let mut sink = engine.listen(&args.guild).expect("gate thread");

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
	let mut early: Vec<Membership> = Vec::new();
	let mut primed = false;
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
				listener.handle_packet(&buffer[..length], Instant::now(), dave.as_ref(), &mut |frame| sink(Heard::Voice(frame)));
			}

			event = events.recv() => {
				let Some(event) = event else { break };
				match event {
					Event::Ready { ssrc: theirs, ip, port, modes } => {
						ssrc = theirs;
						let mode = EncryptionMode::negotiate(&modes).expect("a supported cipher");
						let remote = format!("{ip}:{port}").parse().expect("voice server address");
						let socket = VoiceUdp::connect(remote).await.expect("udp connect");
						let found = socket.discover(ssrc).await.expect("ip discovery");
						handle.select_protocol(found.address, found.port, mode.as_str().to_owned()).await;
						udp = Some(socket);
					}
					Event::SessionDescription { mode, secret_key, dave_protocol_version } => {
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
							fresh.membership(change, Instant::now(), dave.as_ref(), &mut |frame| sink(Heard::Voice(frame)));
						}
						listener = Some(fresh);
						deadline = Some(Instant::now() + Duration::from_secs(args.seconds));
						println!("listening for {}s — say \"Amhra, skip this song\"", args.seconds);
					}
					Event::Dave { opcode, data, payload } => {
						let Some(driver) = dave.as_ref() else { continue };
						let actions = driver
							.lock()
							.expect("dave lock")
							.handle(opcode, &data, &payload)
							.unwrap_or_else(|error| {
								eprintln!("dave {opcode:?} failed: {error}");
								Vec::new()
							});
						for action in actions {
							perform(&handle, action).await;
						}
					}
					Event::Speaking { user_id: speaker, ssrc: theirs, .. } => {
						let change = Membership::Speaking { user_id: speaker, ssrc: theirs };
						match listener.as_mut() {
							Some(listener) => listener.membership(change, Instant::now(), dave.as_ref(), &mut |frame| sink(Heard::Voice(frame))),
							None => early.push(change),
						}
					}
					Event::ClientDisconnect { user_id: gone } => {
						println!("user {gone} left");
						let change = Membership::Disconnect { user_id: gone };
						match listener.as_mut() {
							Some(listener) => {
								listener.membership(change, Instant::now(), dave.as_ref(), &mut |frame| sink(Heard::Voice(frame)));
							}
							None => early.push(change),
						}
						// Whatever they were halfway through saying goes too.
						sink(Heard::Left { user_id: gone });
					}
					Event::Closed(reason) => {
						eprintln!("gateway closed: {reason}");
						break;
					}
					_ => {}
				}
			}
		}

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
	}
}
