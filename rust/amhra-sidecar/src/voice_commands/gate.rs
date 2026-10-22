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
//! window [`GateConfig::preroll`] before the point the spotter says the keyword
//! *ended* — not before the moment it fired.
//!
//! Whether anything was said after the name is decided on the audio after the
//! keyword's end only. Counting the pre-roll would count the name itself as
//! speech, and "Amhra" on its own would then be transcribed rather than time
//! out quietly.

use std::collections::VecDeque;

use super::{Detection, FRAME_SAMPLES, Spotter, Vad, samples};

/// Timings, in milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GateConfig {
	/// Audio kept from before the keyword's end. Usually catches the tail of
	/// the name, which the recogniser handles fine, and the start of a command
	/// said in the same breath, which it otherwise would not hear at all.
	pub preroll_ms: u32,
	/// How long after the name to wait for the command to start.
	pub wait_for_speech_ms: u32,
	/// Speech needed after the name before it counts as a command, so a cough
	/// or a click does not open a five-second window.
	pub min_speech_ms: u32,
	/// Silence that ends the command.
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
}

impl Default for GateConfig {
	fn default() -> Self {
		Self {
			preroll_ms: 300,
			wait_for_speech_ms: 2000,
			min_speech_ms: 100,
			end_silence_ms: 500,
			max_capture_ms: 5000,
			keep_tail_ms: 200,
			max_lag_ms: 1500,
			name_clip_ms: 0,
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
	/// Where in `samples` the spotter says the name ended: the pre-roll,
	/// unless there was less history than that.
	pub name_end: usize,
}

#[derive(Debug)]
enum State {
	Listening,
	/// Heard the name, waiting for the command to start.
	Armed { keyword: String, waited: usize, speech: usize },
	Capturing { keyword: String, silence: usize },
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
	/// Where in the window the name ended.
	name_end: usize,
	state: State,
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
			name_end: 0,
			state: State::Listening,
		}
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

		let Some(Detection { keyword, lag }) = self.spotter.accept(samples) else { return };
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
		self.window.clear();
		self.window.extend(self.history.range(start..));
		self.name_end = keyword_end - start;
		self.history.clear();
		self.state = State::Armed { keyword, waited: 0, speech: 0 };

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

	/// Move the state machine on by `heard` samples, which the VAD judged to be
	/// speech or not. `waiting` is false for audio from before the detection,
	/// which cannot have used up time the speaker was given to start.
	fn advance(&mut self, heard: usize, speech: bool, waiting: bool, events: &mut dyn FnMut(GateEvent)) {
		let limits = self.limits;
		match &mut self.state {
			State::Listening => {}
			State::Armed { keyword, waited, speech: said } => {
				if speech {
					*said += heard;
				}
				if waiting {
					*waited += heard;
				}
				if *said >= limits.min_speech {
					let keyword = std::mem::take(keyword);
					self.state = State::Capturing { keyword, silence: 0 };
				} else if *waited >= limits.wait_for_speech {
					let keyword = std::mem::take(keyword);
					self.finish();
					events(GateEvent::TimedOut { keyword });
					return;
				}
				self.check_cap(events);
			}
			State::Capturing { silence, .. } => {
				*silence = if speech { 0 } else { *silence + heard };
				if *silence >= limits.end_silence {
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
			// Five seconds of the name followed by too little speech to be a
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
		let State::Capturing { keyword, silence } = std::mem::replace(&mut self.state, State::Listening)
		else {
			return;
		};
		let mut samples = std::mem::take(&mut self.window);
		samples.truncate(samples.len() - silence.saturating_sub(self.limits.keep_tail));
		samples.truncate(self.limits.max_capture);
		self.finish();
		let name_end = self.name_end;
		events(GateEvent::Captured(Capture { keyword, samples, since_speech: silence, capped, name_end }));
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

	fn gate(lag: usize) -> Gate {
		Gate::new(GateConfig::default(), Box::new(FakeSpotter { lag }), Box::new(FakeVad))
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

		// 600ms of command, then 600ms of quiet.
		let command = frames(LOUD, 600 / MS_PER_FRAME);
		events.extend(feed(&mut gate, &command));
		events.extend(feed(&mut gate, &frames(0.0, 600 / MS_PER_FRAME)));

		let captures = captured(&events);
		assert_eq!(captures.len(), 1);
		let capture = captures[0];
		assert!(!capture.capped);
		assert_eq!(capture.keyword, "AMHRA");
		// Closed on exactly the configured silence, and timed from there.
		assert_eq!(capture.since_speech, samples(500));
		// Pre-roll + command + the tail that is kept; the rest of the silence
		// is cut.
		assert_eq!(capture.samples.len(), samples(300) + samples(600) + samples(200));
		assert!(gate.is_listening());
	}

	#[test]
	fn the_window_starts_before_where_the_keyword_ended_not_where_it_fired() {
		// The detection arrives 400ms after the name ended, by which time the
		// command is already under way.
		let mut gate = gate(samples(400));
		let mut audio = frames(0.0, 50);
		audio.extend(frames(LOUD, 15)); // the name, 300ms
		audio.extend(frames(0.0, 5)); // a breath
		audio.extend(frames(LOUD, 14)); // the command, already 280ms in…
		audio.push(keyword_frame()); // …when the detection arrives
		let mut events = feed(&mut gate, &audio);
		events.extend(feed(&mut gate, &frames(0.0, 30)));

		let captures = captured(&events);
		assert_eq!(captures.len(), 1);
		// 300ms of pre-roll back from the keyword's end, everything since,
		// and the kept tail.
		assert_eq!(captures[0].samples.len(), samples(300) + samples(400) + samples(200));
		// So the window opens on the name, not on the quiet before it.
		assert!(captures[0].samples[..samples(300)].iter().all(|&sample| sample >= LOUD));
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
		events.extend(feed(&mut gate, &frames(0.0, 2000 / MS_PER_FRAME)));
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
	fn a_click_after_the_name_is_not_a_command() {
		let mut gate = gate(0);
		let mut events = feed(&mut gate, &[keyword_frame()]);
		// 40ms of noise, under the 100ms it takes to count as speech.
		events.extend(feed(&mut gate, &frames(LOUD, 2)));
		events.extend(feed(&mut gate, &frames(0.0, 2000 / MS_PER_FRAME)));
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
		assert_eq!(captures.len(), 1, "one window, not one every five seconds");
		assert!(captures[0].capped);
		assert_eq!(captures[0].samples.len(), samples(5000));
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
		events.extend(feed(&mut gate, &frames(0.0, 600 / MS_PER_FRAME)));
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
		events.extend(feed(&mut gate, &frames(0.0, 10)));
		let captures = captured(&events);
		assert_eq!(captures.len(), 1, "{events:?}");
	}
}
