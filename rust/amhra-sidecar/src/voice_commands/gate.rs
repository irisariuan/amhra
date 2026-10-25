//! One speaker's wake-word gate: listen for the name, then capture what
//! follows until they stop talking.
//!
//! ```text
//!            keyword                 speech                silence ≥ end_silence
//! Listening ────────▶ Armed ─────────────────▶ Capturing ─────────────────────▶ Captured
//!     ▲                 │ no speech within          │ window reaches max_capture
//!     │                 ▼ wait_for_speech           ▼
//!     └──────────── TimedOut                     Captured (capped)
//! ```
//!
//! Time here is counted in samples, not read from a clock: the gate is fed
//! audio and knows nothing else. That keeps it deterministic under test and
//! lets the offline harness run a WAV file faster than real time. Silence that
//! Discord never sent has to be fed in as zeros by the caller (see
//! `speakers.rs`).
//!
//! Where the window starts matters more than anything else here. A streaming
//! spotter is only sure of a word some time after it was said, and people say
//! the command straight after the name, so by the time the detection arrives
//! the command has often begun. The gate keeps a short history and starts the
//! window where the spotter says the keyword *ended* — not at the moment it
//! fired — less [`GateConfig::preroll_ms`], which is none by default.
//!
//! A gate can also be armed without the name ([`Gate::follow_up`]), for a
//! conversation: once the bot has answered someone, it listens to them again
//! as though they had just said it, waiting [`GateConfig::follow_up_wait_ms`]
//! for them to start.
//!
//! A spotter that scores what it hears, like the classifier, also says when
//! it came close and did not wake ([`Spotter::near_miss`]). The gate keeps
//! the audio of each near miss for [`GateConfig::near_miss_ms`], and if the
//! same speaker then wakes it, hands the latest one out with the name
//! ([`GateEvent::NearMiss`]): someone saying the name again because the first
//! time went unheard is how the names a model misses can be collected.
//!
//! Whether anything was said after the name is decided on the audio after the
//! keyword's end only. Counting the pre-roll would count the name itself as
//! speech, and "Amhra" on its own would then be transcribed rather than time
//! out quietly.

use std::collections::VecDeque;

use super::{Detection, FRAME_SAMPLES, NearMiss, Spotter, Vad, samples};

/// Near misses heard less than this apart are one attempt at the name, kept
/// at its highest score.
const ATTEMPT_GAP_MS: u32 = 300;
/// A near miss whose end is closer than this to where the wake's name ended
/// is that same name, scored on its way up to waking, not an earlier try.
const SAME_NAME_MS: u32 = 500;
/// The most near misses kept at once.
const MAX_NEAR: usize = 4;

/// Timings, in milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GateConfig {
	/// Audio kept from before the keyword's end. None by default: any of the
	/// name left in the window throws the recogniser off the word after it.
	/// Spliced after the tails of 12 live wakes, a synthesised "skip" came
	/// back as "S" or "Sip" all but 16 times in 48 with 400ms of the name
	/// before it, and was heard 46 times in 48 with none. A command said in
	/// the same breath fared best with none too, 44 in 48, against 34 with
	/// 300ms.
	pub preroll_ms: u32,
	/// How long after the name is heard to wait for the command to start.
	/// People tend to wait for the chime before going on, so until they have
	/// said something after it, a pause does not end the window either: the
	/// tail of the name alone is not a command.
	pub wait_for_speech_ms: u32,
	/// Speech needed after the name before it counts as a command, so a cough
	/// or a click does not open a five-second window.
	pub min_speech_ms: u32,
	/// Silence that ends the command, once it has started. Every millisecond
	/// of it is added to the wait for an answer.
	pub end_silence_ms: u32,
	/// The longest window, pre-roll included.
	pub max_capture_ms: u32,
	/// Silence kept at the end of the window. The rest of the trailing silence
	/// is cut: it only costs the recogniser time.
	pub keep_tail_ms: u32,
	/// How far back the spotter's lag may reach. A detection claiming more is
	/// clamped to this.
	pub max_lag_ms: u32,
	/// Audio kept from before the keyword's end for [`GateEvent::Name`], so
	/// the name itself can be saved to train the spotter on. Zero sends none.
	pub name_clip_ms: u32,
	/// How long to wait for someone to start, when listening to them again
	/// after the bot answered them. Longer than after the name: they are
	/// answering a question, not finishing a sentence.
	pub follow_up_wait_ms: u32,
	/// How long before a wake a near miss is kept for, to hand out with the
	/// name as one the speaker probably had to repeat. Zero keeps none; only
	/// with [`GateConfig::name_clip_ms`], whose length each is cut to.
	pub near_miss_ms: u32,
}

impl Default for GateConfig {
	fn default() -> Self {
		Self {
			preroll_ms: 0,
			wait_for_speech_ms: 2500,
			min_speech_ms: 100,
			end_silence_ms: 500,
			max_capture_ms: 8000,
			keep_tail_ms: 200,
			max_lag_ms: 1500,
			name_clip_ms: 0,
			follow_up_wait_ms: 5000,
			near_miss_ms: 0,
		}
	}
}

/// What a gate has to say about the audio it was just fed.
#[derive(Debug, Clone, PartialEq)]
pub enum GateEvent {
	/// The name was heard; listening for a command.
	Woke { keyword: String },
	/// The name was heard and nothing followed it.
	TimedOut { keyword: String },
	/// A command, ready to transcribe.
	Captured(Capture),
	/// The audio the name was heard in: [`GateConfig::name_clip_ms`] before
	/// the spotter says it ended, and whatever had been heard after by the
	/// time it said so. Sent straight after `Woke`, and only when asked for.
	Name { keyword: String, samples: Vec<f32> },
	/// The same speaker came close to waking it shortly before: the audio of
	/// that near miss, cut as [`GateEvent::Name`] is, its score, and how many
	/// samples before the name that woke it the near miss ended. Sent straight
	/// after `Name`, and only when [`GateConfig::near_miss_ms`] asks.
	NearMiss { keyword: String, samples: Vec<f32>, score: f32, before: usize },
}

/// A window of speech that followed the wake word.
#[derive(Debug, Clone, PartialEq)]
pub struct Capture {
	pub keyword: String,
	pub samples: Vec<f32>,
	/// How many samples ago the speaker stopped talking, at the moment the
	/// window closed. This is how latency is measured from the end of speech
	/// rather than from the end of the silence that confirmed it.
	pub since_speech: usize,
	/// Closed by [`GateConfig::max_capture_ms`] rather than by silence.
	pub capped: bool,
}

#[derive(Debug)]
enum State {
	Listening,
	/// Heard the name, waiting `wait` samples for the command to start.
	/// `speech` counts all of it, `answered` only what was said after the name
	/// was heard.
	Armed { keyword: String, wait: usize, waited: usize, speech: usize, answered: usize },
	/// Taking the command down. Until `answered` reaches the minimum speech,
	/// all that has been said may be the name, so silence only ends the
	/// window once the wait for speech is over too.
	Capturing { keyword: String, wait: usize, silence: usize, waited: usize, answered: usize },
}

/// Timings converted to samples once.
#[derive(Debug, Clone, Copy)]
struct Limits {
	preroll: usize,
	wait_for_speech: usize,
	min_speech: usize,
	end_silence: usize,
	max_capture: usize,
	keep_tail: usize,
	max_lag: usize,
	name_clip: usize,
	follow_up_wait: usize,
	near_miss: usize,
}

impl Limits {
	/// How much to remember while listening for the name.
	fn history(&self) -> usize {
		self.preroll.max(self.name_clip) + self.max_lag
	}
}

impl From<GateConfig> for Limits {
	fn from(config: GateConfig) -> Self {
		Self {
			preroll: samples(config.preroll_ms),
			wait_for_speech: samples(config.wait_for_speech_ms),
			min_speech: samples(config.min_speech_ms),
			end_silence: samples(config.end_silence_ms),
			max_capture: samples(config.max_capture_ms),
			keep_tail: samples(config.keep_tail_ms),
			max_lag: samples(config.max_lag_ms),
			name_clip: samples(config.name_clip_ms),
			follow_up_wait: samples(config.follow_up_wait_ms),
			near_miss: if config.name_clip_ms > 0 { samples(config.near_miss_ms) } else { 0 },
		}
	}
}

pub struct Gate {
	limits: Limits,
	spotter: Box<dyn Spotter>,
	vad: Box<dyn Vad>,
	/// The last `max(preroll, name_clip) + max_lag` samples heard while
	/// listening.
	history: VecDeque<f32>,
	/// The window being built, once the name has been heard.
	window: Vec<f32>,
	state: State,
	/// Samples heard while listening, ever: where in the stream things are.
	heard: usize,
	/// Recent near misses, oldest first.
	near: VecDeque<Near>,
}

/// One attempt at the name that did not wake the spotter.
#[derive(Debug)]
struct Near {
	samples: Vec<f32>,
	score: f32,
	/// Where in the stream its best-scoring name ended.
	end: usize,
	/// Where the last near miss counted in this attempt ended.
	last: usize,
}

impl std::fmt::Debug for Gate {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Gate")
			.field("state", &self.state)
			.field("history", &self.history.len())
			.field("window", &self.window.len())
			.finish_non_exhaustive()
	}
}

impl Gate {
	pub fn new(config: GateConfig, spotter: Box<dyn Spotter>, vad: Box<dyn Vad>) -> Self {
		let limits = Limits::from(config);
		Self {
			limits,
			spotter,
			vad,
			history: VecDeque::with_capacity(limits.history()),
			window: Vec::new(),
			state: State::Listening,
			heard: 0,
			near: VecDeque::new(),
		}
	}

	/// Take new timings. A command already open keeps the wait for speech it
	/// began with; the silence that ends it and its longest length change at
	/// once.
	pub fn set_config(&mut self, config: GateConfig) {
		self.limits = Limits::from(config);
	}

	/// Not in the middle of anything: no name heard, no command open.
	pub fn is_listening(&self) -> bool {
		matches!(self.state, State::Listening)
	}

	/// Hear `samples`, reporting whatever they complete.
	pub fn push(&mut self, samples: &[f32], events: &mut dyn FnMut(GateEvent)) {
		match self.state {
			State::Listening => self.listen(samples, events),
			State::Armed { .. } | State::Capturing { .. } => {
				self.window.extend_from_slice(samples);
				let speech = self.vad.accept(samples);
				self.advance(samples.len(), speech, true, events);
			}
		}
	}

	fn listen(&mut self, samples: &[f32], events: &mut dyn FnMut(GateEvent)) {
		let keep = self.limits.history();
		self.history.extend(samples.iter().copied());
		if self.history.len() > keep {
			self.history.drain(..self.history.len() - keep);
		}
		self.heard += samples.len();

		let Some(Detection { keyword, lag }) = self.spotter.accept(samples) else {
			if self.limits.near_miss > 0 {
				if let Some(near) = self.spotter.near_miss() {
					self.keep_near(near);
				}
				let (heard, window) = (self.heard, self.limits.near_miss + self.limits.max_lag);
				while self.near.front().is_some_and(|near| heard - near.end > window) {
					self.near.pop_front();
				}
			}
			return;
		};
		self.spotter.reset();
		self.vad.reset();
		events(GateEvent::Woke { keyword: keyword.clone() });

		// Where the name ended, in the history, and the window from a little
		// before it.
		let lag = lag.min(self.limits.max_lag).min(self.history.len());
		let keyword_end = self.history.len() - lag;
		let start = keyword_end.saturating_sub(self.limits.preroll);
		if self.limits.name_clip > 0 {
			let from = keyword_end.saturating_sub(self.limits.name_clip);
			let samples = self.history.range(from..).copied().collect();
			events(GateEvent::Name { keyword: keyword.clone(), samples });
		}
		let end = self.heard - lag;
		let (same, window) = (super::samples(SAME_NAME_MS), self.limits.near_miss);
		let earlier = self.near.drain(..).rev().find(|near| (same..=window).contains(&end.saturating_sub(near.end)));
		if let Some(Near { samples, score, end: near_end, .. }) = earlier {
			events(GateEvent::NearMiss { keyword: keyword.clone(), samples, score, before: end - near_end });
		}
		self.window.clear();
		self.window.extend(self.history.range(start..));
		self.history.clear();
		self.state =
			State::Armed { keyword, wait: self.limits.wait_for_speech, waited: 0, speech: 0, answered: 0 };

		// What has been said since the name ended was heard before the
		// detection arrived. It is the start of the command, if there is one,
		// so the VAD hears it now, a frame at a time, as it would have.
		let after = self.window.len() - lag;
		let mut offset = after;
		while offset < self.window.len() && !self.is_listening() {
			let end = (offset + FRAME_SAMPLES).min(self.window.len());
			let speech = self.vad.accept(&self.window[offset..end]);
			// Already past: it does not count against the wait.
			self.advance(end - offset, speech, false, events);
			offset = end;
		}
	}

	/// Remember a near miss: a new attempt at the name, or a better score for
	/// the one under way.
	fn keep_near(&mut self, NearMiss { score, lag }: NearMiss) {
		let lag = lag.min(self.limits.max_lag).min(self.history.len());
		let end = self.heard - lag;
		let clip = |history: &VecDeque<f32>, name_clip: usize| {
			let from = (history.len() - lag).saturating_sub(name_clip);
			history.range(from..).copied().collect()
		};
		match self.near.back_mut() {
			Some(near) if end.saturating_sub(near.last) <= samples(ATTEMPT_GAP_MS) => {
				near.last = near.last.max(end);
				if score > near.score {
					near.samples = clip(&self.history, self.limits.name_clip);
					near.score = score;
					near.end = end;
				}
			}
			_ => {
				if self.near.len() == MAX_NEAR {
					self.near.pop_front();
				}
				let samples = clip(&self.history, self.limits.name_clip);
				self.near.push_back(Near { samples, score, end, last: end });
			}
		}
	}

	/// Listen for a command as though `keyword` had just been heard, waiting
	/// the follow-up's time for it to start. Nothing, if a command is already
	/// open: theirs is under way.
	pub fn follow_up(&mut self, keyword: &str, events: &mut dyn FnMut(GateEvent)) {
		if !self.is_listening() {
			return;
		}
		self.spotter.reset();
		self.vad.reset();
		self.history.clear();
		self.window.clear();
		// Whatever came close before was not followed by the name.
		self.near.clear();
		self.state = State::Armed {
			keyword: keyword.to_owned(),
			wait: self.limits.follow_up_wait,
			waited: 0,
			speech: 0,
			answered: 0,
		};
		events(GateEvent::Woke { keyword: keyword.to_owned() });
	}

	/// Move the state machine on by `heard` samples, which the VAD judged to be
	/// speech or not. `waiting` is false for audio from before the detection,
	/// which cannot have used up time the speaker was given to start.
	fn advance(&mut self, heard: usize, speech: bool, waiting: bool, events: &mut dyn FnMut(GateEvent)) {
		let limits = self.limits;
		match &mut self.state {
			State::Listening => {}
			State::Armed { keyword, wait, waited, speech: said, answered } => {
				if speech {
					*said += heard;
				}
				if waiting {
					*waited += heard;
					if speech {
						*answered += heard;
					}
				}
				if *said >= limits.min_speech {
					let keyword = std::mem::take(keyword);
					self.state =
						State::Capturing { keyword, wait: *wait, silence: 0, waited: *waited, answered: *answered };
				} else if *waited >= *wait {
					let keyword = std::mem::take(keyword);
					self.finish();
					events(GateEvent::TimedOut { keyword });
					return;
				}
				self.check_cap(events);
			}
			State::Capturing { wait, silence, waited, answered, .. } => {
				*silence = if speech { 0 } else { *silence + heard };
				if waiting {
					*waited += heard;
					if speech {
						*answered += heard;
					}
				}
				let started = *answered >= limits.min_speech || *waited >= *wait;
				if started && *silence >= limits.end_silence {
					self.close(false, events);
				} else {
					self.check_cap(events);
				}
			}
		}
	}

	fn check_cap(&mut self, events: &mut dyn FnMut(GateEvent)) {
		if self.window.len() < self.limits.max_capture {
			return;
		}
		match &self.state {
			State::Capturing { .. } => self.close(true, events),
			// The whole window of the name followed by too little speech to be a
			// command: nothing to transcribe.
			State::Armed { keyword, .. } => {
				let keyword = keyword.clone();
				self.finish();
				events(GateEvent::TimedOut { keyword });
			}
			State::Listening => {}
		}
	}

	fn close(&mut self, capped: bool, events: &mut dyn FnMut(GateEvent)) {
		let State::Capturing { keyword, silence, .. } = std::mem::replace(&mut self.state, State::Listening)
		else {
			return;
		};
		let mut samples = std::mem::take(&mut self.window);
		samples.truncate(samples.len() - silence.saturating_sub(self.limits.keep_tail));
		samples.truncate(self.limits.max_capture);
		self.finish();
		events(GateEvent::Captured(Capture { keyword, samples, since_speech: silence, capped }));
	}

	/// Back to listening for the name.
	fn finish(&mut self) {
		self.state = State::Listening;
		self.window = Vec::new();
		self.vad.reset();
	}
}

/// Fakes shared with `speakers.rs`'s tests.
#[cfg(test)]
pub(crate) mod fakes {
	use super::*;

	/// A sample value that means "the keyword ends here".
	pub const KEYWORD: f32 = 0.75;
	/// Anything at least this loud is speech.
	pub const LOUD: f32 = 0.5;

	/// Fires once per frame containing [`KEYWORD`], with a fixed lag.
	pub struct FakeSpotter {
		pub lag: usize,
	}

	impl Spotter for FakeSpotter {
		fn accept(&mut self, samples: &[f32]) -> Option<Detection> {
			samples
				.contains(&KEYWORD)
				.then(|| Detection { keyword: "AMHRA".to_owned(), lag: self.lag })
		}

		fn reset(&mut self) {}
	}

	/// Speech is anything loud.
	pub struct FakeVad;

	impl Vad for FakeVad {
		fn accept(&mut self, samples: &[f32]) -> bool {
			samples.iter().any(|sample| sample.abs() >= LOUD)
		}

		fn reset(&mut self) {}
	}

	pub fn frames(value: f32, count: usize) -> Vec<Vec<f32>> {
		vec![vec![value; FRAME_SAMPLES]; count]
	}

	/// A frame with the keyword's last sample at its end.
	pub fn keyword_frame() -> Vec<f32> {
		let mut frame = vec![LOUD; FRAME_SAMPLES];
		frame[FRAME_SAMPLES - 1] = KEYWORD;
		frame
	}
}

#[cfg(test)]
mod tests {
	use super::fakes::*;
	use super::*;

	/// 20ms frames.
	const MS_PER_FRAME: usize = 20;

	/// With a pre-roll, so where the window starts can be seen.
	fn gate(lag: usize) -> Gate {
		let config = GateConfig { preroll_ms: 400, ..GateConfig::default() };
		Gate::new(config, Box::new(FakeSpotter { lag }), Box::new(FakeVad))
	}

	fn feed(gate: &mut Gate, frames: &[Vec<f32>]) -> Vec<GateEvent> {
		let mut events = Vec::new();
		for frame in frames {
			gate.push(frame, &mut |event| events.push(event));
		}
		events
	}

	fn captured(events: &[GateEvent]) -> Vec<&Capture> {
		events
			.iter()
			.filter_map(|event| match event {
				GateEvent::Captured(capture) => Some(capture),
				_ => None,
			})
			.collect()
	}

	#[test]
	fn wake_then_speech_then_silence_captures_the_command() {
		let mut gate = gate(0);
		// A second of chatter, then the name.
		let mut events = feed(&mut gate, &frames(0.0, 50));
		events.extend(feed(&mut gate, &[keyword_frame()]));
		assert_eq!(events, vec![GateEvent::Woke { keyword: "AMHRA".to_owned() }]);

		// 600ms of command, then 800ms of quiet.
		let command = frames(LOUD, 600 / MS_PER_FRAME);
		events.extend(feed(&mut gate, &command));
		events.extend(feed(&mut gate, &frames(0.0, 800 / MS_PER_FRAME)));

		let captures = captured(&events);
		assert_eq!(captures.len(), 1);
		let capture = captures[0];
		assert!(!capture.capped);
		assert_eq!(capture.keyword, "AMHRA");
		// Closed on exactly the configured silence, and timed from there.
		assert_eq!(capture.since_speech, samples(500));
		// Pre-roll + command + the tail that is kept; the rest of the silence
		// is cut.
		assert_eq!(capture.samples.len(), samples(400) + samples(600) + samples(200));
		assert!(gate.is_listening());
	}

	#[test]
	fn the_window_starts_before_where_the_keyword_ended_not_where_it_fired() {
		// The detection arrives 400ms after the name ended, by which time the
		// command is already under way.
		let mut gate = gate(samples(400));
		let mut audio = frames(0.0, 50);
		audio.extend(frames(LOUD, 20)); // the name, 400ms
		audio.extend(frames(0.0, 5)); // a breath
		audio.extend(frames(LOUD, 14)); // the command, already 280ms in…
		audio.push(keyword_frame()); // …when the detection arrives
		let mut events = feed(&mut gate, &audio);
		events.extend(feed(&mut gate, &frames(0.0, 2600 / MS_PER_FRAME)));

		let captures = captured(&events);
		assert_eq!(captures.len(), 1);
		// 400ms of pre-roll back from the keyword's end, everything since,
		// and the kept tail.
		assert_eq!(captures[0].samples.len(), samples(400) + samples(400) + samples(200));
		// So the window opens on the name, not on the quiet before it.
		assert!(captures[0].samples[..samples(400)].iter().all(|&sample| sample >= LOUD));
	}

	#[test]
	fn by_default_none_of_the_name_is_in_the_window() {
		let mut gate =
			Gate::new(GateConfig::default(), Box::new(FakeSpotter { lag: samples(200) }), Box::new(FakeVad));
		let mut audio = frames(0.0, 50);
		audio.extend(frames(LOUD, 20)); // the name
		audio.extend(frames(0.0, 9)); // 180ms…
		audio.push(keyword_frame()); // …and the detection, 20ms later
		let mut events = feed(&mut gate, &audio);
		events.extend(feed(&mut gate, &frames(LOUD, 600 / MS_PER_FRAME)));
		events.extend(feed(&mut gate, &frames(0.0, 800 / MS_PER_FRAME)));

		let captures = captured(&events);
		assert_eq!(captures.len(), 1, "{events:?}");
		assert_eq!(captures[0].samples.len(), samples(200 + 600 + 200));
		assert!(captures[0].samples[..samples(180)].iter().all(|&sample| sample == 0.0));
	}

	#[test]
	fn the_name_is_handed_out_when_asked_for() {
		let config = GateConfig { name_clip_ms: 1000, ..GateConfig::default() };
		// Heard 200ms after it ended.
		let mut gate =
			Gate::new(config, Box::new(FakeSpotter { lag: samples(200) }), Box::new(FakeVad));
		let mut audio = frames(0.0, 50); // a second of quiet
		audio.extend(frames(LOUD, 25)); // the name, 500ms
		audio.extend(frames(0.0, 9)); // 180ms…
		audio.push(keyword_frame()); // …and the detection, 20ms later
		let events = feed(&mut gate, &audio);

		assert_eq!(events[0], GateEvent::Woke { keyword: "AMHRA".to_owned() });
		let GateEvent::Name { keyword, samples: clip } = &events[1] else {
			panic!("no name clip: {events:?}");
		};
		assert_eq!(keyword, "AMHRA");
		// A second back from where the name ended, and the 200ms since.
		assert_eq!(clip.len(), samples(1000) + samples(200));
		let name = &clip[samples(500)..samples(1000)];
		assert!(name.iter().all(|&sample| sample >= LOUD), "the name sits before its end");
		assert!(clip[..samples(500)].iter().all(|&sample| sample == 0.0));
	}

	/// A sample value that means "a near miss ends here", scored by how
	/// many of them the frame holds, a tenth each.
	const NEAR: f32 = 0.625;

	/// [`FakeSpotter`], and near misses too.
	struct NearSpotter {
		lag: usize,
		near: Option<NearMiss>,
	}

	impl Spotter for NearSpotter {
		fn accept(&mut self, samples: &[f32]) -> Option<Detection> {
			let count = samples.iter().filter(|&&sample| sample == NEAR).count();
			self.near = (count > 0).then(|| NearMiss { score: count as f32 / 10.0, lag: self.lag });
			samples.contains(&KEYWORD).then(|| Detection { keyword: "AMHRA".to_owned(), lag: self.lag })
		}

		fn near_miss(&mut self) -> Option<NearMiss> {
			self.near.take()
		}

		fn reset(&mut self) {}
	}

	fn near_gate(near_miss_ms: u32) -> Gate {
		let config = GateConfig { name_clip_ms: 1000, near_miss_ms, ..GateConfig::default() };
		Gate::new(config, Box::new(NearSpotter { lag: samples(200), near: None }), Box::new(FakeVad))
	}

	/// A frame ending in a near miss scoring `tenths` tenths.
	fn near_frame(tenths: usize) -> Vec<f32> {
		let mut frame = vec![LOUD; FRAME_SAMPLES];
		frame[FRAME_SAMPLES - tenths..].fill(NEAR);
		frame
	}

	fn near_misses(events: &[GateEvent]) -> Vec<(usize, f32, usize)> {
		events
			.iter()
			.filter_map(|event| match event {
				GateEvent::NearMiss { samples, score, before, .. } => Some((samples.len(), *score, *before)),
				_ => None,
			})
			.collect()
	}

	#[test]
	fn a_near_miss_before_a_wake_is_handed_out_after_the_name() {
		let mut gate = near_gate(8000);
		let mut audio = frames(0.0, 100);
		audio.push(near_frame(3)); // the first try, unheard
		audio.extend(frames(0.0, 99)); // two seconds on…
		audio.push(keyword_frame()); // …the second, heard
		let events = feed(&mut gate, &audio);

		assert!(matches!(events[1], GateEvent::Name { .. }), "{events:?}");
		assert!(matches!(events[2], GateEvent::NearMiss { .. }), "{events:?}");
		// Cut as the name is: a second before it ended, and the 200ms after.
		assert_eq!(near_misses(&events), vec![(samples(1000) + samples(200), 0.3, samples(2000))]);
	}

	#[test]
	fn one_try_is_one_near_miss_at_its_best_score() {
		let mut gate = near_gate(8000);
		let mut audio = frames(0.0, 100);
		audio.extend([near_frame(2), near_frame(5), near_frame(3)]);
		audio.extend(frames(0.0, 50));
		audio.push(keyword_frame());
		let events = feed(&mut gate, &audio);
		// The 0.5, ending 1040ms before the name that woke it.
		assert_eq!(near_misses(&events), vec![(samples(1200), 0.5, samples(1040))]);
	}

	#[test]
	fn the_latest_try_is_the_one_handed_out() {
		let mut gate = near_gate(8000);
		let mut audio = frames(0.0, 100);
		audio.push(near_frame(6));
		audio.extend(frames(0.0, 50));
		audio.push(near_frame(2));
		audio.extend(frames(0.0, 50));
		audio.push(keyword_frame());
		let events = feed(&mut gate, &audio);
		assert_eq!(near_misses(&events), vec![(samples(1200), 0.2, samples(1020))]);
	}

	#[test]
	fn the_wakes_own_name_on_its_way_up_is_not_a_near_miss() {
		let mut gate = near_gate(8000);
		let mut audio = frames(0.0, 100);
		audio.extend([near_frame(4), near_frame(8)]);
		audio.push(keyword_frame());
		let events = feed(&mut gate, &audio);
		assert!(near_misses(&events).is_empty(), "{events:?}");
	}

	#[test]
	fn a_near_miss_long_before_the_wake_is_forgotten() {
		let mut gate = near_gate(3000);
		let mut audio = frames(0.0, 100);
		audio.push(near_frame(5));
		audio.extend(frames(0.0, 200)); // four seconds
		audio.push(keyword_frame());
		let events = feed(&mut gate, &audio);
		assert!(near_misses(&events).is_empty(), "{events:?}");
		assert!(gate.near.is_empty(), "nothing kept past the window");
	}

	#[test]
	fn a_wake_takes_its_near_miss_with_it() {
		let mut gate = near_gate(8000);
		let mut audio = frames(0.0, 100);
		audio.push(near_frame(5));
		audio.extend(frames(0.0, 50));
		audio.push(keyword_frame());
		let mut events = feed(&mut gate, &audio);
		events.extend(feed(&mut gate, &frames(0.0, 2500 / MS_PER_FRAME)));
		events.extend(feed(&mut gate, &[keyword_frame()]));
		assert_eq!(near_misses(&events).len(), 1, "{events:?}");
	}

	#[test]
	fn no_near_misses_unless_asked() {
		let mut gate = near_gate(0);
		let mut audio = frames(0.0, 100);
		audio.push(near_frame(5));
		audio.extend(frames(0.0, 50));
		audio.push(keyword_frame());
		let events = feed(&mut gate, &audio);
		assert!(near_misses(&events).is_empty(), "{events:?}");
	}

	#[test]
	fn no_name_clip_unless_asked() {
		let mut gate = gate(0);
		let events = feed(&mut gate, &[keyword_frame()]);
		assert!(!events.iter().any(|event| matches!(event, GateEvent::Name { .. })));
	}

	#[test]
	fn the_name_alone_times_out_quietly() {
		let mut gate = gate(0);
		let mut events = feed(&mut gate, &[keyword_frame()]);
		events.extend(feed(&mut gate, &frames(0.0, 2500 / MS_PER_FRAME)));
		assert_eq!(
			events,
			vec![
				GateEvent::Woke { keyword: "AMHRA".to_owned() },
				GateEvent::TimedOut { keyword: "AMHRA".to_owned() },
			]
		);
		assert!(gate.is_listening());

		// And it listens again afterwards.
		let events = feed(&mut gate, &[keyword_frame()]);
		assert_eq!(events.len(), 1);
	}

	#[test]
	fn a_follow_up_listens_without_the_name_and_waits_longer() {
		let mut gate = gate(0);
		let mut events = Vec::new();
		gate.follow_up("FOLLOW-UP", &mut |event| events.push(event));
		assert_eq!(events, vec![GateEvent::Woke { keyword: "FOLLOW-UP".to_owned() }]);
		// Past the wait after a name, and still listening…
		events.extend(feed(&mut gate, &frames(0.0, 3000 / MS_PER_FRAME)));
		assert!(!gate.is_listening(), "{events:?}");
		// …for the answer, taken down as a command would be.
		events.extend(feed(&mut gate, &frames(LOUD, 600 / MS_PER_FRAME)));
		events.extend(feed(&mut gate, &frames(0.0, 800 / MS_PER_FRAME)));
		let captures = captured(&events);
		assert_eq!(captures.len(), 1, "{events:?}");
		assert_eq!(captures[0].keyword, "FOLLOW-UP");
		assert!(gate.is_listening());
	}

	#[test]
	fn a_follow_up_nobody_answers_times_out() {
		let mut gate = gate(0);
		let mut events = Vec::new();
		gate.follow_up("FOLLOW-UP", &mut |event| events.push(event));
		events.extend(feed(&mut gate, &frames(0.0, 5000 / MS_PER_FRAME)));
		assert_eq!(events.last(), Some(&GateEvent::TimedOut { keyword: "FOLLOW-UP".to_owned() }));
		assert!(gate.is_listening());
	}

	#[test]
	fn a_follow_up_does_not_cut_into_a_command_under_way() {
		let mut gate = gate(0);
		let mut events = feed(&mut gate, &[keyword_frame()]);
		events.extend(feed(&mut gate, &frames(LOUD, 10)));
		gate.follow_up("FOLLOW-UP", &mut |event| events.push(event));
		assert_eq!(events.iter().filter(|event| matches!(event, GateEvent::Woke { .. })).count(), 1);
		events.extend(feed(&mut gate, &frames(0.0, 800 / MS_PER_FRAME)));
		assert_eq!(captured(&events)[0].keyword, "AMHRA");
	}

	#[test]
	fn a_click_after_the_name_is_not_a_command() {
		let mut gate = gate(0);
		let mut events = feed(&mut gate, &[keyword_frame()]);
		// 40ms of noise, under the 100ms it takes to count as speech.
		events.extend(feed(&mut gate, &frames(LOUD, 2)));
		events.extend(feed(&mut gate, &frames(0.0, 2500 / MS_PER_FRAME)));
		assert!(captured(&events).is_empty());
		assert!(matches!(events.last(), Some(GateEvent::TimedOut { .. })));
	}

	#[test]
	fn a_command_that_never_stops_is_cut_at_the_cap() {
		let mut gate = gate(0);
		let mut events = feed(&mut gate, &frames(0.0, 50));
		events.extend(feed(&mut gate, &[keyword_frame()]));
		events.extend(feed(&mut gate, &frames(LOUD, 10_000 / MS_PER_FRAME)));

		let captures = captured(&events);
		assert_eq!(captures.len(), 1, "one window, not one per cap");
		assert!(captures[0].capped);
		assert_eq!(captures[0].samples.len(), samples(8000));
		assert_eq!(captures[0].since_speech, 0);
		// The talking that continued went back to the spotter, which did not
		// hear the name in it.
		assert!(gate.is_listening());
	}

	#[test]
	fn a_pause_inside_the_command_does_not_end_it() {
		let mut gate = gate(0);
		let mut events = feed(&mut gate, &[keyword_frame()]);
		events.extend(feed(&mut gate, &frames(LOUD, 15)));
		events.extend(feed(&mut gate, &frames(0.0, 400 / MS_PER_FRAME)));
		events.extend(feed(&mut gate, &frames(LOUD, 15)));
		events.extend(feed(&mut gate, &frames(0.0, 800 / MS_PER_FRAME)));
		let captures = captured(&events);
		assert_eq!(captures.len(), 1);
		// Only the keyword frame came before (there was no history to take
		// pre-roll from), then the whole command with its pause.
		assert_eq!(captures[0].samples.len(), samples(20 + 300 + 400 + 300 + 200));
	}

	#[test]
	fn speech_said_before_the_detection_arrived_starts_the_command() {
		// The whole command fits inside the spotter's lag: said, finished and
		// followed by silence, all before the detection.
		let mut gate = gate(samples(1200));
		let mut audio = frames(LOUD, 5); // the name
		audio.extend(frames(LOUD, 15)); // "skip"
		audio.extend(frames(0.0, 44)); // quiet
		audio.push(keyword_frame());
		let mut events = feed(&mut gate, &audio);
		// Nothing said after the chime, so it may all have been the name: the
		// window stays open for the wait.
		events.extend(feed(&mut gate, &frames(0.0, 2000 / MS_PER_FRAME)));
		assert!(captured(&events).is_empty());
		events.extend(feed(&mut gate, &frames(0.0, 500 / MS_PER_FRAME)));
		let captures = captured(&events);
		assert_eq!(captures.len(), 1, "{events:?}");
	}

	#[test]
	fn waiting_for_the_chime_does_not_end_the_command() {
		// The spotter says the name ended 400ms back, 100ms early: its tail
		// comes after, and is enough to count as speech.
		let mut gate = gate(samples(400));
		let mut audio = frames(0.0, 50);
		audio.extend(frames(LOUD, 15)); // the name
		audio.extend(frames(0.0, 14)); // quiet…
		audio.push(keyword_frame()); // …and the detection: the chime
		let mut events = feed(&mut gate, &audio);
		// They wait to hear it, longer than the silence that ends a command…
		events.extend(feed(&mut gate, &frames(0.0, 800 / MS_PER_FRAME)));
		assert!(captured(&events).is_empty(), "closed on the name: {events:?}");
		// …then go on.
		events.extend(feed(&mut gate, &frames(LOUD, 600 / MS_PER_FRAME)));
		events.extend(feed(&mut gate, &frames(0.0, 800 / MS_PER_FRAME)));

		let captures = captured(&events);
		assert_eq!(captures.len(), 1, "{events:?}");
		assert!(!captures[0].capped);
		// Pre-roll, the lag, the wait, the command and the kept tail.
		assert_eq!(captures[0].samples.len(), samples(400 + 400 + 800 + 600 + 200));
		assert!(captures[0].samples[captures[0].samples.len() - samples(800)..][..samples(600)]
			.iter()
			.all(|&sample| sample >= LOUD));
	}
}
