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
//!
//! Tracks normally come from the cache, which the bot fills with `amhra-fetch`
//! before asking for them. A command marked `stream` is the exception: with
//! caching off, this process downloads the track itself, straight into the
//! reader that plays it, and nothing is written to disk.
//!
//! `--listen` also decodes what everyone else in the channel says (see
//! `listen.rs`). It is off by default and, alone, goes nowhere. Even with it,
//! a guild is heard only while its `Connect` or a later `SetListen` says so:
//! voice commands are opted into per guild, by the bot.
//!
//! `--voice-commands` listens for the wake word and transcribes what follows
//! it, reporting `Utterance` events (see `voice_commands`). It implies
//! `--listen`, needs a build with the `voice-commands` feature, and reads:
//!
//! - `--voice-models <dir>`: from `scripts/download-voice-models.sh`, default
//!   `models/voice`;
//! - `--wake-keywords <file>`: the wake phrases, default
//!   `data/wake-keywords.txt`;
//! - `--recogniser-threads <n>`: threads for speech recognition, default 2;
//! - `--recogniser-language <lang>`: auto (the default), en, zh, ja, ko or
//!   yue, for every guild;
//! - `--recogniser-provider cpu|coreml`: where speech recognition runs,
//!   default cpu; coreml needs a build with the `shared-onnxruntime` feature;
//! - `--wake-model <dir>`: a fine-tuned keyword spotter from
//!   `training/wake/export.sh`, instead of the stock one;
//! - `--wake-classifier <dir>`: the wake word classifier from
//!   `training/wake/classifier/export.py`, instead of any keyword spotter
//!   (see `voice_commands::classifier`); `--wake-keywords` and
//!   `--wake-model` are then unused;
//! - `--wake-clips <dir>`: save the second or so of audio each wake was heard
//!   in, for retraining the spotter (see `voice_commands::clips`), at most
//!   `--wake-clips-max <n>` of them, default 2000;
//! - `--wake-chime`: chime in the call when the name is heard, chime again
//!   when what follows has been taken down, and sound softly every two
//!   seconds until the bot answers (see `wake_feedback`);
//! - `--wake-duck <gain>`: lower the music to this from the name until what
//!   follows has been heard (see `wake_feedback`);
//! - `--wait-for-speech-ms`, `--end-silence-ms`, `--max-capture-ms`: how long
//!   to wait for a command after the name, the silence that ends it, and the
//!   longest one, overriding `GateConfig`'s defaults.
//!
//! `--speech` lets the bot speak (`Speak`, `PrepareSpeech`) with whichever
//! speech models are unpacked under `--voice-models` (see `speech::models`:
//! Supertonic 3 for English, Japanese and Korean, Kokoro for Mandarin, a VITS
//! voice for Cantonese), on `--speech-threads <n>` CPU threads, default 1.
//! Phrases are saved under `<cache-dir>/speech` and each model is loaded only
//! to make new ones (see `speech`). It needs the `voice-commands` feature and
//! lowers the music to `--wake-duck` meanwhile. A `Speak` that answers a
//! member can ask to listen to them again afterwards, without the name.
//!
//! Paths are relative to the directory the sidecar is started in. A model
//! that will not load is reported once as an `Error` event and the sidecar
//! carries on without voice commands: playback never depends on them.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use amhra_audio::CacheReader;
use amhra_fetch::Extractor;
use amhra_fetch::download::DownloadOptions;
use amhra_sidecar::framing::{read_frame, write_frame};
use amhra_sidecar::protocol::{Command, Event, PROTOCOL_VERSION, SessionState};
use amhra_sidecar::speech::{Answer, Speech, Voice};
use amhra_sidecar::worker::{Worker, WorkerCommand};

/// Each connected guild's audio thread, for what the voice-command threads
/// need to tell it: they hear the name, but the guild map is the main loop's.
type Workers = Arc<Mutex<HashMap<String, Sender<WorkerCommand>>>>;
use amhra_voice::dave::driver::{Action, Driver};
use amhra_voice::gateway::{self, ConnectionInfo, Event as GatewayEvent};
use amhra_sidecar::listen::{ListenSetup, VoiceSink};
use amhra_sidecar::voice_commands::engine::Engine;
use amhra_voice::player::FadeSettings;
use amhra_voice::receive::Membership;
use amhra_voice::wire::EncryptionMode;
use amhra_voice::{Opener, Session, VoiceUdp};

/// Audio saved from before where the name ended, for `--wake-clips`. The
/// name is about half a second; the rest is context, as the training cuts have.
#[cfg(feature = "voice-commands")]
const WAKE_CLIP_MS: u32 = 1000;

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
	main_gain: f32,
	/// Whether this guild's receive thread passes packets on. Shared with it,
	/// so `SetListen` takes effect without a reconnect.
	listening: Arc<AtomicBool>,
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

/// Downloads for tracks played without the cache.
struct Streamer {
	/// An operator's client ladder, when the bot was given one.
	profiles: Option<std::path::PathBuf>,
	/// Built on first use and kept: it holds the connection pool and the
	/// minted visitor id, and every stream after the first reuses both.
	extractor: Option<Arc<Extractor>>,
}

impl Streamer {
	/// Start downloading `track_id` and return the reader that will play it.
	///
	/// Returns at once with an empty reader; the audio follows as it lands.
	/// Dropping the reader cancels the download at its next chunk.
	fn open(
		&mut self,
		events: &Sender<Event>,
		guild_id: &str,
		track_id: &str,
	) -> Result<CacheReader, String> {
		let extractor = match &self.extractor {
			Some(extractor) => Arc::clone(extractor),
			None => {
				let profiles = amhra_fetch::innertube::load_profiles(self.profiles.as_deref())
					.map_err(|error| error.to_string())?;
				let extractor =
					Arc::new(Extractor::new(profiles).map_err(|error| error.to_string())?);
				self.extractor = Some(Arc::clone(&extractor));
				extractor
			}
		};

		let (mut writer, feed) = amhra_audio::stream::channel();
		let (events, guild_id, track_id) =
			(events.clone(), guild_id.to_owned(), track_id.to_owned());
		tokio::spawn(async move {
			let started = std::time::Instant::now();
			let outcome =
				amhra_fetch::stream(&track_id, &extractor, DownloadOptions::default(), &mut writer)
					.await;
			match outcome {
				Ok(done) => eprintln!(
					"[{guild_id}] streamed {track_id} via {} in {}ms ({} bytes)",
					done.profile,
					started.elapsed().as_millis(),
					done.bytes
				),
				Err(amhra_fetch::StreamError::Abandoned) => {}
				// The writer goes with this task either way, which ends the
				// track where its audio does — immediately, if none arrived —
				// so the queue moves on rather than waiting on a dead download.
				Err(amhra_fetch::StreamError::Failed(reason)) => {
					let message = if writer.sent() == 0 {
						format!("cannot stream {track_id}: {reason}")
					} else {
						format!("stream of {track_id} ended early: {reason}")
					};
					fail(&events, &guild_id, message);
				}
			}
		});
		Ok(CacheReader::streaming(feed))
	}
}

#[tokio::main]
async fn main() {
	let cache_dir =
		std::path::PathBuf::from(option("--cache-dir").unwrap_or_else(|| "cache".to_owned()));
	let profiles = option("--profiles").map(std::path::PathBuf::from);
	let mut streamer = Streamer { profiles, extractor: None };
	let voice_commands = flag("--voice-commands");
	let listen = flag("--listen") || voice_commands;
	if listen {
		eprintln!("listening: other members' audio will be decrypted and decoded");
	}

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

	let workers: Workers = Arc::default();
	let voice = if voice_commands { start_voice_commands(&events, &workers) } else { None };
	let speech = start_speech(&cache_dir, &workers, voice.clone(), &events);

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
		let context = Context {
			cache_dir: &cache_dir,
			listen,
			voice: voice.as_ref(),
			workers: &workers,
			speech: speech.as_ref(),
		};
		dispatch(command, &mut guilds, &events, &context, &mut streamer).await;
	}

	eprintln!("shutting down {} guild(s)", guilds.len());
	for (_, session) in guilds.drain() {
		session.stand_down().await;
	}
}

/// What every command may need, set up once at startup.
struct Context<'a> {
	cache_dir: &'a std::path::Path,
	listen: bool,
	voice: Option<&'a Arc<Engine>>,
	workers: &'a Workers,
	speech: Option<&'a Speech>,
}

async fn dispatch(
	command: Command,
	guilds: &mut HashMap<String, GuildSession>,
	events: &Sender<Event>,
	context: &Context<'_>,
	streamer: &mut Streamer,
) {
	let Context { cache_dir, listen, voice, workers, speech } = *context;
	match command {
		Command::Connect { guild_id, channel_id, user_id, session_id, endpoint, token, listen: wanted } => {
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
			let listening = Arc::new(AtomicBool::new(wanted));

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
				listen.then(|| listening.clone()),
				voice.cloned(),
			));

			if let Ok(mut workers) = workers.lock() {
				workers.insert(guild_id.clone(), worker.command_sender());
			}
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
					main_gain: 1.0,
					listening,
				},
			);
		}

		Command::Disconnect { guild_id } => {
			if let Ok(mut workers) = workers.lock() {
				workers.remove(&guild_id);
			}
			if let Some(session) = guilds.remove(&guild_id) {
				session.stand_down().await;
				let _ = events.send(Event::Disconnected {
					guild_id,
					reason: "asked to leave".to_owned(),
				});
			}
		}

		Command::Play { guild_id, track_id, start_ms, stream } => {
			let source = Source { cache_dir, streamer, stream };
			if let Some((session, reader)) =
				with_track(guilds, events, &guild_id, &track_id, source, "play")
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

		Command::SetNext { guild_id, track_id, stream } => {
			let source = Source { cache_dir, streamer, stream };
			if let Some((session, reader)) =
				with_track(guilds, events, &guild_id, &track_id, source, "queue")
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
		Command::SetMainVolume { guild_id, gain } => {
			with_guild(guilds, events, &guild_id, |session| {
				session.main_gain = gain;
				session.worker.send(WorkerCommand::SetMainVolume(gain));
			})
		}
		Command::AddLayer { guild_id, layer_id, track_id, gain, start_ms, stream } => {
			let source = Source { cache_dir, streamer, stream };
			if let Some((session, reader)) =
				with_track(guilds, events, &guild_id, &track_id, source, "layer")
			{
				session.worker.send(WorkerCommand::AddLayer {
					layer_id,
					track_id,
					reader: Box::new(reader),
					gain,
					start_ms,
				});
			}
		}
		Command::RemoveLayer { guild_id, layer_id } => {
			with_guild(guilds, events, &guild_id, |session| {
				session.worker.send(WorkerCommand::RemoveLayer(layer_id));
			})
		}
		Command::SetLayerVolume { guild_id, layer_id, gain } => {
			with_guild(guilds, events, &guild_id, |session| {
				session.worker.send(WorkerCommand::SetLayerVolume { layer_id, gain });
			})
		}
		Command::SwapLayer { guild_id, layer_id } => {
			with_guild(guilds, events, &guild_id, |session| {
				session.worker.send(WorkerCommand::SwapLayer(layer_id));
			})
		}
		Command::SetFades { guild_id, crossfade_ms, skip_fade_ms } => {
			with_guild(guilds, events, &guild_id, |session| {
				session
					.worker
					.send(WorkerCommand::SetFades(FadeSettings { crossfade_ms, skip_fade_ms }));
			})
		}

		Command::SetListen { guild_id, listen } => {
			with_guild(guilds, events, &guild_id, |session| {
				session.listening.store(listen, Ordering::Relaxed);
			})
		}

		Command::Speak { guild_id, text, language, user_id, listen } => {
			let voice = Voice::for_language(language.as_deref());
			let answers = user_id.and_then(|user_id| user_id.parse::<u64>().ok());
			match (speech, answers) {
				(Some(speech), Some(user_id)) => speech.answer(guild_id, text, voice, Answer { user_id, listen }),
				(Some(speech), None) => speech.say(guild_id, text, voice),
				// Nothing will be said, so nobody is to be kept waiting for it.
				(None, Some(user_id)) => settle(guilds, &guild_id, user_id),
				(None, None) => {}
			}
		}
		Command::Settle { guild_id, user_id } => {
			if let Ok(user_id) = user_id.parse() {
				settle(guilds, &guild_id, user_id);
			}
		}
		Command::PrepareSpeech { phrases } => {
			for phrase in phrases {
				if let Some(speech) = speech {
					speech.prepare(phrase.text, Voice::for_language(phrase.language.as_deref()));
				}
			}
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
					main_gain: session.main_gain,
				})
				.collect();
			let _ = events.send(Event::Sessions { guilds });
		}

		Command::Shutdown => {}
	}
}

/// Stop waiting on `user_id` in `guild_id`, if the bot is still there.
fn settle(guilds: &HashMap<String, GuildSession>, guild_id: &str, user_id: u64) {
	if let Some(session) = guilds.get(guild_id) {
		session.worker.send(WorkerCommand::Settled { user_id });
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

/// Where a track named by a command should come from.
struct Source<'a> {
	cache_dir: &'a std::path::Path,
	streamer: &'a mut Streamer,
	stream: bool,
}

impl Source<'_> {
	fn open(
		self,
		events: &Sender<Event>,
		guild_id: &str,
		track_id: &str,
	) -> Result<CacheReader, String> {
		if !self.stream {
			return CacheReader::open(self.cache_dir, track_id).map_err(|error| error.to_string());
		}
		// A whole cached copy is free to play and needs no network. A partial
		// one is not trusted: with caching off nothing here is downloading it,
		// so it may be the remains of a fetch that died and would never grow.
		if self.cache_dir.join(format!("{track_id}.music")).exists()
			&& let Ok(reader) = CacheReader::open(self.cache_dir, track_id)
		{
			return Ok(reader);
		}
		self.streamer.open(events, guild_id, track_id)
	}
}

/// The connected guild and an open track, or nothing and a reported reason.
///
/// The commands that name a track — play it now, queue it for the seam, layer
/// it over the rest — all have the same two ways of not happening, and `verb`
/// is all that differs between what they say when the track will not open.
fn with_track<'a>(
	guilds: &'a mut HashMap<String, GuildSession>,
	events: &Sender<Event>,
	guild_id: &str,
	track_id: &str,
	source: Source<'_>,
	verb: &str,
) -> Option<(&'a mut GuildSession, CacheReader)> {
	let Some(session) = guilds.get_mut(guild_id) else {
		not_connected(events, guild_id);
		return None;
	};
	match source.open(events, guild_id, track_id) {
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
	// The guild's switch, when this process can listen at all.
	listen: Option<Arc<AtomicBool>>,
	voice: Option<Arc<Engine>>,
) {
	let mut ssrc = 0u32;
	// Who owns which SSRC, as far as this connection has been told. Kept here
	// as well as in the receive thread because `speaking` can arrive before
	// the keys do, and a receive thread started later still needs to know.
	let mut speakers: HashMap<u32, u64> = HashMap::new();
	let mut membership: Option<std::sync::mpsc::Sender<Membership>> = None;
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

						let listen = if let Some(enabled) = &listen {
							listen_setup(&mut membership, &speakers, mode, &secret_key, ssrc, enabled.clone())
								.map(|mut setup| {
									if let Some(engine) = &voice {
										setup.sink = voice_sink(engine, &events, &guild_id);
									}
									setup
								})
								.map_err(|error| fail(&events, &guild_id, error))
								.ok()
						} else {
							None
						};
						let _ = worker.send(WorkerCommand::Attach {
							socket,
							session: Box::new(session),
							dave: dave.clone(),
							listen,
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

					GatewayEvent::Speaking { user_id, ssrc: theirs, flags: _ } => {
						speakers.insert(theirs, user_id);
						if let Some(membership) = &membership {
							let _ = membership.send(Membership::Speaking { user_id, ssrc: theirs });
						}
					}

					GatewayEvent::ClientDisconnect { user_id } => {
						speakers.retain(|_, speaker| *speaker != user_id);
						if let Some(membership) = &membership {
							let _ = membership.send(Membership::Disconnect { user_id });
						}
					}

					// Joining tells us nothing a receiver can use: SSRCs only
					// arrive with `speaking`.
					GatewayEvent::ClientsConnect { .. } => {}

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
							// A new session hands out new SSRCs.
							speakers.clear();
							membership = None;
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

/// Everything the worker needs to start a receive thread for this session.
///
/// The membership channel is new each time — the previous receive thread ends
/// with its attachment — and is primed with every SSRC already announced.
fn listen_setup(
	membership: &mut Option<std::sync::mpsc::Sender<Membership>>,
	speakers: &HashMap<u32, u64>,
	mode: EncryptionMode,
	secret_key: &[u8],
	own_ssrc: u32,
	enabled: Arc<AtomicBool>,
) -> Result<ListenSetup, String> {
	let opener =
		Opener::new(mode, secret_key).map_err(|error| format!("listen: bad session key: {error}"))?;
	let (sender, receiver) = std::sync::mpsc::channel();
	for (&ssrc, &user_id) in speakers {
		let _ = sender.send(Membership::Speaking { user_id, ssrc });
	}
	*membership = Some(sender);
	// Decoded and let go, unless voice commands replace this.
	Ok(ListenSetup { opener, own_ssrc, membership: receiver, sink: Box::new(|_| {}), enabled })
}

/// A gate thread for this call's voice, or — if one cannot be started —
/// nowhere, said once.
fn voice_sink(engine: &Engine, events: &Sender<Event>, guild_id: &str) -> VoiceSink {
	engine.listen(guild_id).unwrap_or_else(|error| {
		fail(events, guild_id, format!("could not start voice commands: {error}"));
		Box::new(|_| {})
	})
}

/// Load the models and start the recogniser. Slow — the speech model is a
/// quarter of a gigabyte — so it happens once, at startup, before any guild
/// connects.
#[cfg(feature = "voice-commands")]
fn start_voice_commands(events: &Sender<Event>, workers: &Workers) -> Option<Arc<Engine>> {
	use amhra_sidecar::voice_commands::clips::ClipStore;
	use amhra_sidecar::voice_commands::engine::Notice;
	use amhra_sidecar::voice_commands::gate::GateConfig;
	use amhra_sidecar::voice_commands::sherpa::{self, SherpaConfig};

	let models = option("--voice-models").unwrap_or_else(|| "models/voice".to_owned());
	let keywords = option("--wake-keywords").unwrap_or_else(|| "data/wake-keywords.txt".to_owned());
	let classifier = option("--wake-classifier");
	let started = std::time::Instant::now();
	// The classifier hears only the name it was trained on.
	let keywords = match classifier {
		Some(_) => Ok(String::new()),
		None => std::fs::read_to_string(&keywords).map_err(|error| format!("cannot read {keywords}: {error}")),
	};
	let loaded = keywords
		.and_then(|keywords| {
			let mut config = SherpaConfig::new(models.into(), keywords);
			if let Some(threads) =
				option("--recogniser-threads").and_then(|threads| threads.parse().ok()).filter(|threads| *threads >= 1)
			{
				config.recogniser_threads = threads;
			}
			config.spotter = option("--wake-model").map(Into::into);
			config.classifier = classifier.clone().map(Into::into);
			config.recogniser_provider = recogniser_provider(events);
			if let Some(language) = option("--recogniser-language") {
				config.recogniser_language = language;
			}
			sherpa::load(&config).map_err(|error| error.to_string())
		});
	let (models, recogniser) = match loaded {
		Ok(loaded) => loaded,
		Err(message) => {
			let message = format!("voice commands are off: {message}");
			eprintln!("{message}");
			let _ = events.send(Event::Error { guild_id: None, message });
			return None;
		}
	};

	// A clip store that will not open costs the clips, not voice commands.
	let clips = option("--wake-clips").and_then(|dir| {
		let max = option("--wake-clips-max").and_then(|max| max.parse().ok()).unwrap_or(2000);
		ClipStore::open(dir.clone().into(), max)
			.map_err(|error| eprintln!("voice commands: not saving wake clips: cannot use {dir}: {error}"))
			.ok()
	});
	let defaults = GateConfig::default();
	let ms = |name, default| option(name).and_then(|ms| ms.parse().ok()).unwrap_or(default);
	let gate = GateConfig {
		wait_for_speech_ms: ms("--wait-for-speech-ms", defaults.wait_for_speech_ms),
		end_silence_ms: ms("--end-silence-ms", defaults.end_silence_ms),
		max_capture_ms: ms("--max-capture-ms", defaults.max_capture_ms),
		name_clip_ms: if clips.is_some() { WAKE_CLIP_MS } else { 0 },
		..defaults
	};
	if let Some(clips) = &clips {
		eprintln!("voice commands: saving wake clips to {}", clips.dir().display());
	}
	let clips = clips.map(Mutex::new);
	let chime = flag("--wake-chime");
	let duck = option("--wake-duck").and_then(|gain| gain.parse::<f32>().ok()).unwrap_or(1.0);
	let workers = Arc::clone(workers);
	let tell = move |guild_id: &str, command: WorkerCommand| {
		if let Some(worker) = workers.lock().ok().and_then(|workers| workers.get(guild_id).cloned()) {
			let _ = worker.send(command);
		}
	};

	let events = events.clone();
	let report = Arc::new(move |notice: Notice| match notice {
		Notice::Utterance { guild_id, user_id, keyword, text, lang, latency_ms, recognition_ms, audio_ms } => {
			// What was said goes to the bot only, not into the log.
			eprintln!(
				"[{guild_id}] voice: {user_id} after {keyword}: {audio_ms}ms of speech, {} chars, {}, text {latency_ms}ms after they stopped ({recognition_ms}ms recognising)",
				text.chars().count(),
				lang.as_deref().unwrap_or("language unknown"),
			);
			tell(&guild_id, WorkerCommand::Heard);
			let _ = events.send(Event::Utterance {
				guild_id,
				user_id: user_id.to_string(),
				text,
				lang,
				wake_keyword: keyword,
				latency_ms,
			});
		}
		Notice::Woke { guild_id, user_id, keyword } => {
			eprintln!("[{guild_id}] voice: {user_id} said {keyword}");
			tell(&guild_id, WorkerCommand::Woke { chime, duck });
			let _ = events.send(Event::Woke { guild_id, user_id: user_id.to_string() });
		}
		Notice::TimedOut { guild_id, user_id, keyword } => {
			eprintln!("[{guild_id}] voice: {user_id} said {keyword} and nothing after it");
			tell(&guild_id, WorkerCommand::Heard);
			tell(&guild_id, WorkerCommand::Closed { chime });
			let _ = events.send(Event::NothingHeard { guild_id, user_id: user_id.to_string() });
		}
		Notice::Name { guild_id, user_id, samples, .. } => {
			let Some(Ok(mut clips)) = clips.as_ref().map(Mutex::lock) else { return };
			let at = std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.map_or(0, |since| since.as_millis());
			match clips.save(&guild_id, user_id, &samples, at) {
				Ok(Some(path)) => eprintln!("[{guild_id}] voice: saved wake clip {}", path.display()),
				Ok(None) => {}
				Err(error) => eprintln!("[{guild_id}] voice: could not save a wake clip: {error}"),
			}
		}
		Notice::Captured { guild_id, user_id, .. } => {
			tell(&guild_id, WorkerCommand::Captured { user_id, chime, duck });
		}
		Notice::Unintelligible { guild_id, user_id, keyword } => {
			eprintln!("[{guild_id}] voice: {user_id} said {keyword}, then nothing recognisable");
			tell(&guild_id, WorkerCommand::Heard);
			tell(&guild_id, WorkerCommand::Settled { user_id });
			let _ = events.send(Event::NothingHeard { guild_id, user_id: user_id.to_string() });
		}
		Notice::Dropped { guild_id, what, count } => {
			eprintln!("[{guild_id}] voice: behind, dropped {count} {what}");
			// A dropped command is a wake that will never be heard.
			if what == "commands" {
				for _ in 0..count {
					tell(&guild_id, WorkerCommand::Heard);
				}
			}
		}
		Notice::Failed { guild_id, message } => fail(&events, &guild_id, format!("voice commands: {message}")),
	});
	match Engine::start(models, Box::new(recogniser), gate, report) {
		Ok(engine) => {
			match &classifier {
				Some(dir) => eprintln!("voice commands: models loaded in {:?}, the wake classifier from {dir}", started.elapsed()),
				None => eprintln!("voice commands: models loaded in {:?}", started.elapsed()),
			}
			Some(Arc::new(engine))
		}
		Err(error) => {
			eprintln!("voice commands are off: could not start the recogniser: {error}");
			None
		}
	}
}

/// The provider asked for, or the CPU, saying why when that is not what was
/// asked for.
#[cfg(feature = "voice-commands")]
fn recogniser_provider(events: &Sender<Event>) -> amhra_sidecar::voice_commands::sherpa::Provider {
	use amhra_sidecar::voice_commands::sherpa::Provider;
	let Some(name) = option("--recogniser-provider") else { return Provider::Cpu };
	let fallback = |message: String| {
		eprintln!("{message}");
		let _ = events.send(Event::Error { guild_id: None, message });
		Provider::Cpu
	};
	match Provider::parse(&name) {
		Some(provider) if provider.available() => {
			eprintln!("voice commands: recognising on {}", provider.name());
			provider
		}
		Some(provider) => fallback(format!(
			"voice commands: {} is not in this build (it needs --features shared-onnxruntime, on macOS); recognising on the cpu",
			provider.name()
		)),
		None => fallback(format!("voice commands: unknown recogniser provider {name:?}; recognising on the cpu")),
	}
}

#[cfg(not(feature = "voice-commands"))]
fn start_voice_commands(events: &Sender<Event>, _workers: &Workers) -> Option<Arc<Engine>> {
	let message = "voice commands are off: this sidecar was built without the voice-commands feature".to_owned();
	eprintln!("{message}");
	let _ = events.send(Event::Error { guild_id: None, message });
	None
}

/// The speech thread, if `--speech` asks for one and any speech model is
/// there. The models themselves are not loaded until something new has to be
/// said.
#[cfg(feature = "voice-commands")]
fn start_speech(
	cache_dir: &std::path::Path,
	workers: &Workers,
	voice: Option<Arc<Engine>>,
	events: &Sender<Event>,
) -> Option<Speech> {
	use amhra_sidecar::speech::models;

	if !flag("--speech") {
		return None;
	}
	let dir = option("--voice-models").unwrap_or_else(|| "models/voice".to_owned());
	let threads = option("--speech-threads").and_then(|threads| threads.parse().ok()).filter(|n| *n >= 1).unwrap_or(1);
	let found = models::under(std::path::Path::new(&dir), threads);
	if found.is_empty() {
		eprintln!(
			"speech is off: none of {}, {} or {} is in {dir}; run scripts/download-voice-models.sh --speech",
			models::SUPERTONIC,
			models::KOKORO,
			models::CANTONESE
		);
		return None;
	}
	for model in &found {
		let voices: Vec<&str> = model.voices.iter().map(|voice| voice.name()).collect();
		eprintln!("speech: {} for {}, on {threads} thread(s) when a phrase is new", model.name, voices.join(", "));
	}
	let duck = option("--wake-duck").and_then(|gain| gain.parse::<f32>().ok()).unwrap_or(1.0);
	let workers = Arc::clone(workers);
	let events = events.clone();
	let deliver = Box::new(move |guild_id: &str, pcm: Arc<[i16]>, answer: Option<Answer>| {
		// Listening again needs voice commands, and something said to answer
		// back to. An answer that was to be listened back to and cannot be
		// said comes to nothing, as a wake does that nothing follows.
		let listen = answer.filter(|answer| answer.listen && voice.is_some());
		if let Some(answer) = listen
			&& pcm.is_empty()
		{
			let _ = events.send(Event::NothingHeard { guild_id: guild_id.to_owned(), user_id: answer.user_id.to_string() });
		}
		let Some(worker) = workers.lock().ok().and_then(|workers| workers.get(guild_id).cloned()) else { return };
		let then = listen.filter(|_| !pcm.is_empty()).and_then(|answer| {
			let engine = Arc::clone(voice.as_ref()?);
			let guild_id = guild_id.to_owned();
			Some(Box::new(move || engine.follow_up(&guild_id, answer.user_id)) as amhra_sidecar::wake_feedback::Then)
		});
		let _ = worker.send(WorkerCommand::Say { pcm, duck, answers: answer.map(|answer| answer.user_id), then });
	});
	match Speech::start(found, Some(cache_dir.join("speech")), deliver) {
		Ok(speech) => Some(speech),
		Err(error) => {
			eprintln!("speech is off: {error}");
			None
		}
	}
}

#[cfg(not(feature = "voice-commands"))]
fn start_speech(
	_cache_dir: &std::path::Path,
	_workers: &Workers,
	_voice: Option<Arc<Engine>>,
	_events: &Sender<Event>,
) -> Option<Speech> {
	if flag("--speech") {
		eprintln!("speech is off: this sidecar was built without the voice-commands feature");
	}
	None
}

/// The value after `name` on the command line.
fn option(name: &str) -> Option<String> {
	std::env::args().skip_while(|argument| argument != name).nth(1)
}

fn flag(name: &str) -> bool {
	std::env::args().any(|argument| argument == name)
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
