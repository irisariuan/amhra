//! `amhra-sidecar` — the process that owns Discord voice.
//!
//! The bot keeps the main gateway, the queue and every user-facing decision.
//! This process owns the parts that must not wait on a JavaScript event loop:
//! the voice connection, the encryption, and the 20ms tick. Audio never crosses
//! the boundary — only the handful of control messages a user action produces.
//!
//! Commands arrive as length-prefixed JSON on **stdin** and events leave the
//! same way on **stdout**; logs go to stderr and are never framed. The plan
//! called for a dedicated fd 3, but a pipe is one-directional, so that would
//! need two extra descriptors and relies on the spawner supporting them. A
//! stdin/stdout pair is bidirectional by construction and behaves identically
//! under Bun and Node — and stdout stays clean because logging has its own
//! stream.
//!
//! Losing stdin means the bot is gone, which is the shutdown signal: there is
//! nothing left to play for.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use amhra_audio::CacheReader;
use amhra_sidecar::framing::{read_frame, write_frame};
use amhra_sidecar::protocol::{Command, Event, PROTOCOL_VERSION, SessionState};
use amhra_sidecar::worker::{Worker, WorkerCommand};
use amhra_voice::dave::driver::{Action, Driver};
use amhra_voice::gateway::{self, ConnectionInfo, Event as GatewayEvent};
use amhra_voice::player::FadeSettings;
use amhra_voice::wire::EncryptionMode;
use amhra_voice::{Session, VoiceUdp};

/// How often the gateway task checks whether the audio thread wants the
/// speaking flag changed. The flag is a courtesy to the client's UI, not part
/// of the audio path, so it does not need to be tick-accurate.
const SPEAKING_POLL: Duration = Duration::from_millis(100);

/// How many DAVE frames to hold while waiting for the session description.
/// The join sequence is a handful of messages, so this is slack, not a queue.
const MAX_EARLY_DAVE: usize = 32;

/// Highest DAVE version this build speaks. Zero is refused by the server.
const MAX_DAVE_VERSION: u8 = amhra_voice::dave::PROTOCOL_VERSION;

struct GuildSession {
	worker: Worker,
	gateway: gateway::GatewayHandle,
	/// Cleared when this session is replaced or told to leave.
	///
	/// Closing the gateway is not instant: the task keeps draining its channel
	/// for a moment afterwards, and a `Disconnected` it emits then would be read
	/// by the bot as the *current* session dropping — which tears down a
	/// connection that is fine and leaves the guild silent with nothing to
	/// explain it.
	alive: Arc<AtomicBool>,
	channel_id: String,
	track_id: Option<String>,
	position_ms: u32,
	paused: bool,
	gain: f32,
}

impl GuildSession {
	/// Close this session for good, in the one order that is safe.
	///
	/// The flag has to be cleared before the gateway is closed, and every way a
	/// session ends — replaced, told to leave, or caught by shutdown — has to do
	/// it. Written once because it was previously written three times, and the
	/// third copy had already forgotten the flag.
	async fn stand_down(self) {
		self.alive.store(false, Ordering::Relaxed);
		self.gateway.close().await;
		self.worker.shutdown();
	}
}

#[tokio::main]
async fn main() {
	let cache_dir = std::env::args()
		.skip_while(|argument| argument != "--cache-dir")
		.nth(1)
		.unwrap_or_else(|| "cache".to_owned());
	let cache_dir = std::path::PathBuf::from(cache_dir);

	// Events are written by one thread so frames from the audio threads and the
	// gateway tasks cannot interleave halfway through.
	let (events, outbox) = std::sync::mpsc::channel::<Event>();
	std::thread::spawn(move || {
		let mut stdout = std::io::stdout().lock();
		while let Ok(event) = outbox.recv() {
			if let Err(error) = write_frame(&mut stdout, &event) {
				eprintln!("failed to write event: {error}");
				return;
			}
		}
	});

	let _ = events.send(Event::Hello { version: PROTOCOL_VERSION, pid: std::process::id() });

	// stdin is blocking, so it gets its own thread rather than stalling the
	// runtime that every gateway connection shares.
	let (commands, mut inbox) = tokio::sync::mpsc::unbounded_channel::<Command>();
	let reader_events = events.clone();
	std::thread::spawn(move || {
		let mut stdin = std::io::stdin().lock();
		let mut buffer = Vec::new();
		loop {
			match read_frame::<Command>(&mut stdin, &mut buffer) {
				Ok(command) => {
					if commands.send(command).is_err() {
						return;
					}
				}
				Err(error) if error.is_eof() => {
					eprintln!("stdin closed, shutting down");
					return;
				}
				// A bad frame is the bot's problem to fix, not a reason to
				// drop every guild: report it and keep reading.
				Err(error) => {
					let _ = reader_events.send(Event::Error {
						guild_id: None,
						message: format!("bad command frame: {error}"),
					});
					if !matches!(error, amhra_sidecar::framing::FrameError::Json(_)) {
						return;
					}
				}
			}
		}
	});

	let mut guilds: HashMap<String, GuildSession> = HashMap::new();

	while let Some(command) = inbox.recv().await {
		if matches!(command, Command::Shutdown) {
			break;
		}
		dispatch(command, &mut guilds, &events, &cache_dir).await;
	}

	eprintln!("shutting down {} guild(s)", guilds.len());
	for (_, session) in guilds.drain() {
		session.stand_down().await;
	}
}

async fn dispatch(
	command: Command,
	guilds: &mut HashMap<String, GuildSession>,
	events: &Sender<Event>,
	cache_dir: &std::path::Path,
) {
	match command {
		Command::Connect { guild_id, channel_id, user_id, session_id, endpoint, token } => {
			// Reconnecting to the same guild replaces the old session rather
			// than leaving two things sending to one channel.
			if let Some(existing) = guilds.remove(&guild_id) {
				existing.stand_down().await;
			}

			let worker = match Worker::spawn(guild_id.clone(), events.clone()) {
				Ok(worker) => worker,
				Err(error) => {
					let _ = events.send(Event::Error {
						guild_id: Some(guild_id),
						message: format!("could not start the audio thread: {error}"),
					});
					return;
				}
			};

			let info = ConnectionInfo {
				endpoint,
				guild_id: guild_id.clone(),
				user_id: user_id.clone(),
				session_id,
				token,
				max_dave_protocol_version: MAX_DAVE_VERSION,
			};
			let (handle, gateway_events) = gateway::connect(info);
			let alive = Arc::new(AtomicBool::new(true));

			tokio::spawn(drive_connection(
				guild_id.clone(),
				channel_id.clone(),
				user_id,
				handle.clone(),
				gateway_events,
				events.clone(),
				worker.command_sender(),
				worker.speaking_flag(),
				alive.clone(),
			));

			guilds.insert(
				guild_id,
				GuildSession {
					worker,
					gateway: handle,
					alive,
					channel_id,
					track_id: None,
					position_ms: 0,
					paused: false,
					gain: 1.0,
				},
			);
		}

		Command::Disconnect { guild_id } => {
			if let Some(session) = guilds.remove(&guild_id) {
				session.stand_down().await;
				let _ = events.send(Event::Disconnected {
					guild_id,
					reason: "asked to leave".to_owned(),
				});
			}
		}

		Command::Play { guild_id, track_id, start_ms } => {
			if let Some((session, reader)) =
				with_track(guilds, events, &guild_id, &track_id, cache_dir, "play")
			{
				session.track_id = Some(track_id.clone());
				session.position_ms = start_ms;
				session.paused = false;
				session.worker.send(WorkerCommand::Play {
					track_id,
					reader: Box::new(reader),
					start_ms,
				});
			}
		}

		Command::SetNext { guild_id, track_id } => {
			if let Some((session, reader)) =
				with_track(guilds, events, &guild_id, &track_id, cache_dir, "queue")
			{
				session.worker.send(WorkerCommand::SetNext { track_id, reader: Box::new(reader) });
			}
		}

		Command::ClearNext { guild_id } => with_guild(guilds, events, &guild_id, |session| {
			session.worker.send(WorkerCommand::ClearNext)
		}),
		Command::Skip { guild_id } => with_guild(guilds, events, &guild_id, |session| {
			session.worker.send(WorkerCommand::Skip)
		}),
		Command::Stop { guild_id } => with_guild(guilds, events, &guild_id, |session| {
			session.track_id = None;
			session.worker.send(WorkerCommand::Stop);
		}),
		Command::Pause { guild_id } => with_guild(guilds, events, &guild_id, |session| {
			session.paused = true;
			session.worker.send(WorkerCommand::Pause);
		}),
		Command::Resume { guild_id } => with_guild(guilds, events, &guild_id, |session| {
			session.paused = false;
			session.worker.send(WorkerCommand::Resume);
		}),
		Command::Seek { guild_id, position_ms } => {
			with_guild(guilds, events, &guild_id, |session| {
				session.position_ms = position_ms;
				session.worker.send(WorkerCommand::Seek(position_ms));
			})
		}
		Command::SetVolume { guild_id, gain } => {
			with_guild(guilds, events, &guild_id, |session| {
				session.gain = gain;
				session.worker.send(WorkerCommand::SetVolume(gain));
			})
		}
		Command::SetFades { guild_id, crossfade_ms, skip_fade_ms } => {
			with_guild(guilds, events, &guild_id, |session| {
				session
					.worker
					.send(WorkerCommand::SetFades(FadeSettings { crossfade_ms, skip_fade_ms }));
			})
		}

		Command::ListSessions => {
			let guilds = guilds
				.iter()
				.map(|(guild_id, session)| SessionState {
					guild_id: guild_id.clone(),
					channel_id: session.channel_id.clone(),
					track_id: session.track_id.clone(),
					position_ms: session.position_ms,
					paused: session.paused,
					gain: session.gain,
				})
				.collect();
			let _ = events.send(Event::Sessions { guilds });
		}

		Command::Shutdown => {}
	}
}

fn with_guild(
	guilds: &mut HashMap<String, GuildSession>,
	events: &Sender<Event>,
	guild_id: &str,
	act: impl FnOnce(&mut GuildSession),
) {
	match guilds.get_mut(guild_id) {
		Some(session) => act(session),
		None => not_connected(events, guild_id),
	}
}

/// The connected guild and an open cache file, or nothing and a reported reason.
///
/// The two commands that name a track — play it now, queue it for the seam —
/// both have the same two ways of not happening, and `verb` is all that differs
/// between what they say when the file will not open.
fn with_track<'a>(
	guilds: &'a mut HashMap<String, GuildSession>,
	events: &Sender<Event>,
	guild_id: &str,
	track_id: &str,
	cache_dir: &std::path::Path,
	verb: &str,
) -> Option<(&'a mut GuildSession, CacheReader)> {
	let Some(session) = guilds.get_mut(guild_id) else {
		not_connected(events, guild_id);
		return None;
	};
	match CacheReader::open(cache_dir, track_id) {
		Ok(reader) => Some((session, reader)),
		Err(error) => {
			let _ = events.send(Event::Error {
				guild_id: Some(guild_id.to_owned()),
				message: format!("cannot {verb} {track_id}: {error}"),
			});
			None
		}
	}
}

fn not_connected(events: &Sender<Event>, guild_id: &str) {
	let _ = events.send(Event::Error {
		guild_id: Some(guild_id.to_owned()),
		message: "not connected to a voice channel".to_owned(),
	});
}

/// Drive one guild's voice connection from handshake to teardown.
#[allow(clippy::too_many_arguments)]
async fn drive_connection(
	guild_id: String,
	channel_id: String,
	user_id: String,
	handle: gateway::GatewayHandle,
	mut gateway_events: tokio::sync::mpsc::Receiver<GatewayEvent>,
	events: Sender<Event>,
	worker: Sender<WorkerCommand>,
	speaking: Arc<std::sync::atomic::AtomicBool>,
	alive: Arc<AtomicBool>,
) {
	let mut ssrc = 0u32;
	let mut udp: Option<VoiceUdp> = None;
	let mut dave: Option<Arc<Mutex<Driver>>> = None;
	// DAVE frames that arrived before the keys did. The driver cannot exist
	// until the session description says which DAVE version this call runs, and
	// the server does not wait for that before it starts driving the join.
	// Dropping those frames loses the external sender, and without it every
	// proposal that follows lands on a group we never built.
	let mut early: Vec<(amhra_voice::wire::Opcode, serde_json::Value, Vec<u8>)> = Vec::new();
	let mut speaking_sent = false;
	let mut poll = tokio::time::interval(SPEAKING_POLL);

	loop {
		tokio::select! {
			// Mirror the audio thread's wish into the gateway. Only this task
			// may talk to the socket, so the flag crosses as an atomic.
			_ = poll.tick() => {
				let wanted = speaking.load(std::sync::atomic::Ordering::Relaxed);
				if wanted != speaking_sent {
					speaking_sent = wanted;
					handle.set_speaking(wanted).await;
				}
			}

			event = gateway_events.recv() => {
				let Some(event) = event else { return };
				// This guild belongs to a newer session now. Anything still in
				// flight here describes a connection the bot has already been
				// told about, so it is dropped rather than reported over the
				// top of the live one.
				if !alive.load(Ordering::Relaxed) {
					return;
				}
				match event {
					GatewayEvent::Ready { ssrc: theirs, ip, port, modes } => {
						ssrc = theirs;
						let Some(mode) = EncryptionMode::negotiate(&modes) else {
							fail(&events, &guild_id, "no supported encryption mode".to_owned());
							return;
						};
						let Ok(address) = format!("{ip}:{port}").parse() else {
							fail(&events, &guild_id, format!("bad voice address {ip}:{port}"));
							return;
						};
						match VoiceUdp::connect(address).await {
							Ok(socket) => match socket.discover(ssrc).await {
								Ok(found) => {
									handle
										.select_protocol(
											found.address,
											found.port,
											mode.as_str().to_owned(),
										)
										.await;
									udp = Some(socket);
								}
								Err(error) => {
									fail(&events, &guild_id, format!("ip discovery: {error}"));
									return;
								}
							},
							Err(error) => {
								fail(&events, &guild_id, format!("udp: {error}"));
								return;
							}
						}
					}

					GatewayEvent::SessionDescription { mode, secret_key, dave_protocol_version } => {
						let Some(mode) = EncryptionMode::parse(&mode) else {
							fail(&events, &guild_id, format!("unknown cipher {mode}"));
							return;
						};
						let Some(socket) = udp.take() else {
							fail(&events, &guild_id, "keys arrived before the socket".to_owned());
							return;
						};
						let session = match Session::new(mode, &secret_key, ssrc) {
							Ok(session) => session,
							Err(error) => {
								fail(&events, &guild_id, format!("bad session key: {error}"));
								return;
							}
						};
						let socket = match socket.into_blocking() {
							Ok(socket) => socket,
							Err(error) => {
								fail(&events, &guild_id, format!("socket handoff: {error}"));
								return;
							}
						};

						if dave_protocol_version > 0 {
							let (parsed_guild, parsed_channel) =
								(guild_id.parse::<u64>(), channel_id.parse::<u64>());
							let user = user_id.parse::<u64>();
							let (Ok(_), Ok(channel), Ok(user)) =
								(parsed_guild, parsed_channel, user)
							else {
								fail(&events, &guild_id, "ids are not numeric".to_owned());
								return;
							};
							match Driver::new(dave_protocol_version, user, channel) {
								Ok(mut driver) => {
									// The server waits for a key package before
									// it announces anything of its own.
									if let Ok(actions) = driver.start() {
										for action in actions {
											perform(&handle, action).await;
										}
									}
									dave = Some(Arc::new(Mutex::new(driver)));
								}
								Err(error) => {
									fail(&events, &guild_id, format!("dave: {error}"));
									return;
								}
							}
						}

						// Whatever the server sent while it was waiting for us,
						// in the order it sent it.
						if let Some(driver) = dave.as_ref() {
							for (opcode, data, payload) in early.drain(..) {
								feed_dave(driver, &handle, &events, &guild_id, opcode, &data, &payload)
									.await;
							}
						} else {
							early.clear();
						}

						let _ = worker.send(WorkerCommand::Attach {
							socket,
							session: Box::new(session),
							dave: dave.clone(),
						});
						let _ = events.send(Event::Ready {
							guild_id: guild_id.clone(),
							dave_version: dave_protocol_version,
						});
					}

					GatewayEvent::Dave { opcode, data, payload } => {
						let Some(driver) = dave.as_ref() else {
							// Bounded: a server that talks this much before the
							// session description is not one this build can
							// follow anyway, and an unbounded queue here would
							// grow for as long as the call lasts.
							if early.len() < MAX_EARLY_DAVE {
								early.push((opcode, data, payload));
							}
							continue;
						};
						feed_dave(driver, &handle, &events, &guild_id, opcode, &data, &payload).await;
					}

					GatewayEvent::Reconnecting { reason, resumable } => {
						// Only a session that is starting over gets a new socket
						// and new keys, and only that one is worth detaching for.
						// A resume keeps both, and nothing re-attaches after it —
						// there is no second session description — so detaching
						// here would silence the guild for the rest of the call.
						if !resumable {
							let _ = worker.send(WorkerCommand::Detach);
							// The next session builds its group from scratch.
							// Frames for it that arrive before its session
							// description are held rather than fed to the
							// driver of a call that no longer exists.
							dave = None;
							early.clear();
						}
						let _ = events
							.send(Event::Reconnecting { guild_id: guild_id.clone(), reason });
					}

					GatewayEvent::Closed(reason) => {
						let _ = worker.send(WorkerCommand::Detach);
						let _ = events
							.send(Event::Disconnected { guild_id: guild_id.clone(), reason });
						return;
					}

					GatewayEvent::Resumed => {}
				}
			}
		}
	}
}

/// Hand one DAVE frame to the driver and send back whatever it answers with.
async fn feed_dave(
	driver: &Arc<Mutex<Driver>>,
	handle: &gateway::GatewayHandle,
	events: &Sender<Event>,
	guild_id: &str,
	opcode: amhra_voice::wire::Opcode,
	data: &serde_json::Value,
	payload: &[u8],
) {
	let outcome = {
		let Ok(mut driver) = driver.lock() else { return };
		driver.handle(opcode, data, payload)
	};
	match outcome {
		Ok(actions) => {
			for action in actions {
				perform(handle, action).await;
			}
		}
		Err(error) => fail(events, guild_id, format!("dave {opcode:?}: {error}")),
	}
}

async fn perform(handle: &gateway::GatewayHandle, action: Action) {
	match action {
		Action::Binary { opcode, payload } => handle.send_binary(opcode, payload).await,
		Action::Transition { opcode, transition_id } => {
			handle.send_json(opcode, serde_json::json!({ "transition_id": transition_id })).await
		}
	}
}

fn fail(events: &Sender<Event>, guild_id: &str, message: String) {
	eprintln!("[{guild_id}] {message}");
	let _ = events.send(Event::Error { guild_id: Some(guild_id.to_owned()), message });
}
