//! The threads: a gate thread per guild, one recogniser for the process.
//!
//! ```text
//! listen-<guild> ──try_send──▶ gate-<guild> ──try_send──▶ recogniser ──▶ report
//!   (receive)       ≤ 500        (spotter, VAD)   ≤ 4      (Qwen3-ASR)
//! ```
//!
//! The recogniser is shared because its model is up to a gigabyte and a
//! command takes it a fraction of a second; one copy serves every guild.
//! The spotter is shared the same way, but its per-speaker state is not, and
//! that state lives on the gate thread of the guild the speaker is in.
//!
//! Both queues drop rather than block. The receive thread must keep reading
//! its socket whatever happens downstream, and a command that waited behind a
//! backlog would be acted on long after the user gave up on it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::gate::{GateConfig, GateEvent};
use super::speakers::Speakers;
use super::{Models, Transcriber, milliseconds};
use crate::listen::{Heard, VoiceSink};

/// Frames queued for a guild's gate thread: two seconds of five people.
const FRAME_QUEUE: usize = 500;
/// Windows queued for the recogniser. More than this waiting means it is
/// already seconds behind.
const JOB_QUEUE: usize = 4;
/// How often the gate thread wakes when nothing arrives, to fill silence.
const TICK: Duration = Duration::from_millis(20);
/// How often dropped frames are reported, when there are any.
const REPORT_DROPS_EVERY: Duration = Duration::from_secs(10);
/// Both threads only call into the models; neither recurses.
const STACK_SIZE: usize = 2 * 1024 * 1024;

/// What stands in for the wake word when someone is listened to again after
/// the bot answered them (see [`Engine::follow_up`]).
pub const FOLLOW_UP: &str = "FOLLOW-UP";

/// What the pipeline has to say. The sidecar turns `Utterance` into a protocol
/// event and logs the rest; the examples print all of it.
#[derive(Debug, Clone, PartialEq)]
pub enum Notice {
	/// Someone said the wake word.
	Woke { guild_id: String, user_id: u64, keyword: String },
	/// The audio the wake word was heard in, when the gate was asked for it.
	Name { guild_id: String, user_id: u64, keyword: String, samples: Vec<f32> },
	/// …and then nothing.
	TimedOut { guild_id: String, user_id: u64, keyword: String },
	/// What followed it has been taken down and is being recognised. An
	/// `Utterance` or `Unintelligible` follows, unless it was dropped.
	Captured { guild_id: String, user_id: u64, keyword: String },
	/// A command, as text.
	Utterance {
		guild_id: String,
		user_id: u64,
		keyword: String,
		text: String,
		lang: Option<String>,
		/// From the end of their speech to the text being ready. Includes the
		/// silence that had to pass before the command counted as finished.
		latency_ms: u32,
		/// The recogniser's share of that.
		recognition_ms: u32,
		/// Length of the window recognised.
		audio_ms: u32,
	},
	/// Speech after the name that the recogniser made nothing of, or failed
	/// on (reported as `Failed` first).
	Unintelligible { guild_id: String, user_id: u64, keyword: String },
	/// Work shed because a queue was full.
	Dropped { guild_id: String, what: &'static str, count: u64 },
	Failed { guild_id: String, message: String },
}

pub type Report = Arc<dyn Fn(Notice) + Send + Sync>;

struct Job {
	guild_id: String,
	user_id: u64,
	keyword: String,
	samples: Vec<f32>,
	/// When they stopped talking, as best the gate can tell.
	speech_ended: Instant,
}

/// Voice commands for the whole process.
pub struct Engine {
	models: Arc<dyn Models>,
	/// What new gates start with; see [`Engine::set_config`].
	config: Mutex<GateConfig>,
	jobs: SyncSender<Job>,
	report: Report,
	/// Each listening guild's gate thread, for [`Engine::follow_up`] and
	/// [`Engine::set_config`]. A guild whose call ended keeps its entry until
	/// it is replaced: sending to it fails, harmlessly.
	controls: Mutex<HashMap<String, Sender<Control>>>,
}

/// What a gate thread is told besides the audio.
enum Control {
	/// Listen to this member again without the name.
	FollowUp(u64),
	/// New timings for everyone in the guild.
	Config(GateConfig),
}

impl Engine {
	/// Start the recogniser thread. It runs until the engine and every gate
	/// thread started from it are gone.
	pub fn start(
		models: Arc<dyn Models>,
		transcriber: Box<dyn Transcriber>,
		config: GateConfig,
		report: Report,
	) -> std::io::Result<Self> {
		let (jobs, queue) = std::sync::mpsc::sync_channel(JOB_QUEUE);
		let thread_report = Arc::clone(&report);
		std::thread::Builder::new()
			.name("recogniser".to_owned())
			.stack_size(STACK_SIZE)
			.spawn(move || recognise(queue, transcriber, thread_report))?;
		Ok(Self { models, config: Mutex::new(config), jobs, report, controls: Mutex::default() })
	}

	/// Start gating one guild's voice. Hand the returned sink to the receive
	/// thread; when it is dropped, the gate thread ends.
	pub fn listen(&self, guild_id: &str) -> std::io::Result<VoiceSink> {
		let (frames, inbox) = std::sync::mpsc::sync_channel(FRAME_QUEUE);
		let (control, controls) = std::sync::mpsc::channel();
		let dropped = Arc::new(AtomicU64::new(0));
		let gate = GateThread {
			guild_id: guild_id.to_owned(),
			speakers: Speakers::new(Arc::clone(&self.models), self.config()),
			jobs: self.jobs.clone(),
			report: Arc::clone(&self.report),
			dropped: Arc::clone(&dropped),
		};
		std::thread::Builder::new()
			.name(format!("gate-{guild_id}"))
			.stack_size(STACK_SIZE)
			.spawn(move || gate.run(inbox, controls))?;
		if let Ok(mut map) = self.controls.lock() {
			map.insert(guild_id.to_owned(), control);
		}

		Ok(Box::new(move |heard| {
			if let Err(TrySendError::Full(_)) = frames.try_send(heard) {
				dropped.fetch_add(1, Ordering::Relaxed);
			}
		}))
	}

	/// Listen to `user_id` in `guild_id` again, without waiting for the name:
	/// the bot has answered them and they may answer back. Never blocks, so
	/// the audio thread may call it.
	pub fn follow_up(&self, guild_id: &str, user_id: u64) {
		if let Some(gate) = self.controls.lock().ok().and_then(|map| map.get(guild_id).cloned()) {
			let _ = gate.send(Control::FollowUp(user_id));
		}
	}

	/// The timings gates start with now.
	pub fn config(&self) -> GateConfig {
		self.config.lock().map(|config| *config).unwrap_or_default()
	}

	/// Change the timings: for every guild listening now, commands already
	/// open included (see [`super::gate::Gate::set_config`]), and every one
	/// that starts listening later.
	pub fn set_config(&self, config: GateConfig) {
		if let Ok(mut current) = self.config.lock() {
			*current = config;
		}
		if let Ok(mut map) = self.controls.lock() {
			// A call that ended has no thread to tell, nor any need of it.
			map.retain(|_, gate| gate.send(Control::Config(config)).is_ok());
		}
	}
}

struct GateThread {
	guild_id: String,
	speakers: Speakers,
	jobs: SyncSender<Job>,
	report: Report,
	/// Counted by the sink, on the receive thread.
	dropped: Arc<AtomicU64>,
}

impl GateThread {
	fn run(mut self, inbox: Receiver<Heard>, controls: Receiver<Control>) {
		let mut reported_drops = 0;
		let mut last_drop_report = Instant::now();
		let mut model_failed = false;

		loop {
			let heard = match inbox.recv_timeout(TICK) {
				Ok(heard) => Some(heard),
				Err(RecvTimeoutError::Timeout) => None,
				// The receive thread, and with it the call, is gone.
				Err(RecvTimeoutError::Disconnected) => return,
			};
			let now = Instant::now();
			let Self { guild_id, speakers, jobs, report, .. } = &mut self;
			let mut handle = |user_id, event| handle(guild_id, jobs, report, user_id, event, now);

			match heard {
				Some(Heard::Voice(frame)) => {
					if let Err(error) = speakers.frame(frame.user_id, &frame.pcm, now, &mut handle)
						&& !model_failed
					{
						// Every frame would fail the same way; say so once.
						model_failed = true;
						report(Notice::Failed { guild_id: guild_id.clone(), message: error.to_string() });
					}
				}
				Some(Heard::Left { user_id }) => speakers.left(user_id),
				None => {}
			}
			while let Ok(control) = controls.try_recv() {
				match control {
					Control::FollowUp(user_id) => {
						if let Err(error) = speakers.follow_up(user_id, FOLLOW_UP, now, &mut handle) {
							report(Notice::Failed { guild_id: guild_id.clone(), message: error.to_string() });
						}
					}
					Control::Config(config) => speakers.set_config(config),
				}
			}
			speakers.tick(now, &mut handle);

			if now.duration_since(last_drop_report) >= REPORT_DROPS_EVERY {
				let dropped = self.dropped.load(Ordering::Relaxed);
				if dropped > reported_drops {
					(self.report)(Notice::Dropped {
						guild_id: self.guild_id.clone(),
						what: "frames",
						count: dropped - reported_drops,
					});
					reported_drops = dropped;
				}
				last_drop_report = now;
			}
		}
	}
}

fn handle(
	guild_id: &str,
	jobs: &SyncSender<Job>,
	report: &Report,
	user_id: u64,
	event: GateEvent,
	now: Instant,
) {
	let guild_id = guild_id.to_owned();
	match event {
		GateEvent::Woke { keyword } => report(Notice::Woke { guild_id, user_id, keyword }),
		GateEvent::TimedOut { keyword } => report(Notice::TimedOut { guild_id, user_id, keyword }),
		GateEvent::Name { keyword, samples } => {
			report(Notice::Name { guild_id, user_id, keyword, samples })
		}
		GateEvent::Captured(capture) => {
			let since = Duration::from_millis(milliseconds(capture.since_speech).into());
			let job = Job {
				guild_id: guild_id.clone(),
				user_id,
				keyword: capture.keyword,
				samples: capture.samples,
				speech_ended: now.checked_sub(since).unwrap_or(now),
			};
			let keyword = job.keyword.clone();
			match jobs.try_send(job) {
				Ok(()) => report(Notice::Captured { guild_id, user_id, keyword }),
				Err(TrySendError::Full(_)) => {
					report(Notice::Dropped { guild_id, what: "commands", count: 1 })
				}
				// The engine is shutting down.
				Err(TrySendError::Disconnected(_)) => {}
			}
		}
	}
}

fn recognise(queue: Receiver<Job>, mut transcriber: Box<dyn Transcriber>, report: Report) {
	for job in queue {
		let started = Instant::now();
		let outcome = transcriber.transcribe(&job.samples);
		let done = Instant::now();
		let Job { guild_id, user_id, keyword, samples, speech_ended } = job;
		match outcome {
			Ok(transcript) if transcript.text.trim().is_empty() => {
				report(Notice::Unintelligible { guild_id, user_id, keyword })
			}
			Ok(transcript) => report(Notice::Utterance {
				guild_id,
				user_id,
				keyword,
				text: transcript.text.trim().to_owned(),
				lang: transcript.lang,
				latency_ms: millis(done.duration_since(speech_ended)),
				recognition_ms: millis(done.duration_since(started)),
				audio_ms: milliseconds(samples.len()),
			}),
			Err(error) => {
				report(Notice::Failed { guild_id: guild_id.clone(), message: error.to_string() });
				report(Notice::Unintelligible { guild_id, user_id, keyword });
			}
		}
	}
}

fn millis(duration: Duration) -> u32 {
	u32::try_from(duration.as_millis()).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
	use super::super::gate::fakes::*;
	use super::super::{FRAME_SAMPLES, ModelError, Spotter, Transcript, Vad};
	use super::*;
	use amhra_voice::receive::VoiceFrame;
	use std::sync::Mutex;

	struct FakeModels;

	impl Models for FakeModels {
		fn spotter(&self) -> Result<Box<dyn Spotter>, ModelError> {
			Ok(Box::new(FakeSpotter { lag: 0 }))
		}

		fn vad(&self) -> Result<Box<dyn Vad>, ModelError> {
			Ok(Box::new(FakeVad))
		}
	}

	struct FakeTranscriber;

	impl Transcriber for FakeTranscriber {
		fn transcribe(&mut self, samples: &[f32]) -> Result<Transcript, ModelError> {
			Ok(Transcript { text: format!(" {} samples ", samples.len()), lang: Some("en".to_owned()) })
		}
	}

	fn voice(user_id: u64, frame: &[f32]) -> Heard {
		Heard::Voice(VoiceFrame {
			user_id,
			ssrc: 1,
			sequence: 0,
			pcm: frame.iter().map(|&sample| (sample * 32768.0) as i16).collect(),
			concealed: false,
		})
	}

	#[test]
	fn a_command_flows_from_the_sink_to_a_reported_utterance() {
		let notices = Arc::new(Mutex::new(Vec::new()));
		let sink_notices = Arc::clone(&notices);
		let engine = Engine::start(
			Arc::new(FakeModels),
			Box::new(FakeTranscriber),
			GateConfig::default(),
			Arc::new(move |notice| sink_notices.lock().unwrap().push(notice)),
		)
		.unwrap();
		let mut sink = engine.listen("7").unwrap();

		sink(voice(42, &keyword_frame()));
		for _ in 0..10 {
			sink(voice(42, &[LOUD; FRAME_SAMPLES]));
		}
		// Nothing more is sent: the gate thread fills the silence itself.
		let deadline = Instant::now() + Duration::from_secs(5);
		let utterance = loop {
			let found = notices
				.lock()
				.unwrap()
				.iter()
				.find(|notice| matches!(notice, Notice::Utterance { .. }))
				.cloned();
			if let Some(found) = found {
				break found;
			}
			assert!(Instant::now() < deadline, "no utterance: {:?}", notices.lock().unwrap());
			std::thread::sleep(Duration::from_millis(20));
		};
		let Notice::Utterance { guild_id, user_id, keyword, text, lang, latency_ms, .. } = utterance else {
			unreachable!()
		};
		assert_eq!((guild_id.as_str(), user_id, keyword.as_str()), ("7", 42, "AMHRA"));
		assert_eq!(lang.as_deref(), Some("en"));
		assert!(text.ends_with("samples"), "trimmed: {text:?}");
		// Half a second of silence had to pass before the command was over.
		assert!(latency_ms >= 450, "{latency_ms}");
		assert!(matches!(notices.lock().unwrap()[0], Notice::Woke { .. }));
	}

	fn wait_for(notices: &Mutex<Vec<Notice>>, found: impl Fn(&Notice) -> bool) {
		let deadline = Instant::now() + Duration::from_secs(5);
		while !notices.lock().unwrap().iter().any(&found) {
			assert!(Instant::now() < deadline, "not reported: {:?}", notices.lock().unwrap());
			std::thread::sleep(Duration::from_millis(20));
		}
	}

	#[test]
	fn a_follow_up_takes_down_an_answer_without_the_name() {
		let notices = Arc::new(Mutex::new(Vec::new()));
		let sink_notices = Arc::clone(&notices);
		let engine = Engine::start(
			Arc::new(FakeModels),
			Box::new(FakeTranscriber),
			GateConfig::default(),
			Arc::new(move |notice| sink_notices.lock().unwrap().push(notice)),
		)
		.unwrap();
		let mut sink = engine.listen("7").unwrap();
		engine.follow_up("7", 42);
		wait_for(&notices, |notice| matches!(notice, Notice::Woke { keyword, .. } if keyword == FOLLOW_UP));
		for _ in 0..10 {
			sink(voice(42, &[LOUD; FRAME_SAMPLES]));
		}
		wait_for(&notices, |notice| matches!(notice, Notice::Captured { user_id: 42, .. }));
		wait_for(&notices, |notice| matches!(notice, Notice::Utterance { keyword, .. } if keyword == FOLLOW_UP));
		// A guild nobody is listening in is not an error.
		engine.follow_up("8", 42);
	}

	#[test]
	fn new_timings_reach_a_guild_already_listening() {
		let notices = Arc::new(Mutex::new(Vec::new()));
		let sink_notices = Arc::clone(&notices);
		let engine = Engine::start(
			Arc::new(FakeModels),
			Box::new(FakeTranscriber),
			GateConfig::default(),
			Arc::new(move |notice| sink_notices.lock().unwrap().push(notice)),
		)
		.unwrap();
		let mut sink = engine.listen("7").unwrap();
		let patient = GateConfig { end_silence_ms: 1500, ..engine.config() };
		engine.set_config(patient);
		assert_eq!(engine.config(), patient);

		sink(voice(42, &keyword_frame()));
		for _ in 0..10 {
			sink(voice(42, &[LOUD; FRAME_SAMPLES]));
		}
		wait_for(&notices, |notice| matches!(notice, Notice::Utterance { .. }));
		let latency = notices.lock().unwrap().iter().find_map(|notice| match notice {
			Notice::Utterance { latency_ms, .. } => Some(*latency_ms),
			_ => None,
		});
		// The command waited out the new silence, not the half second it
		// started with.
		assert!(latency.unwrap() >= 1450, "{latency:?}");
	}

	#[test]
	fn a_full_queue_drops_instead_of_blocking_the_receive_thread() {
		struct Stuck;
		impl Models for Stuck {
			fn spotter(&self) -> Result<Box<dyn Spotter>, ModelError> {
				// Holds the gate thread up on its first frame.
				std::thread::sleep(Duration::from_secs(1));
				Ok(Box::new(FakeSpotter { lag: 0 }))
			}
			fn vad(&self) -> Result<Box<dyn Vad>, ModelError> {
				Ok(Box::new(FakeVad))
			}
		}
		let engine =
			Engine::start(Arc::new(Stuck), Box::new(FakeTranscriber), GateConfig::default(), Arc::new(|_| {}))
				.unwrap();
		let mut sink = engine.listen("7").unwrap();
		let started = Instant::now();
		for _ in 0..FRAME_QUEUE * 3 {
			sink(voice(42, &[0.0; FRAME_SAMPLES]));
		}
		assert!(started.elapsed() < Duration::from_millis(500), "the sink never waits");
	}
}
