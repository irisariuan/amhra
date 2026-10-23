//! Everyone in one call, each with their own gate.
//!
//! Two speakers talking over each other are two streams, never one: the
//! receive path already separates them by SSRC, and each gets its own spotter
//! and VAD here, so one person's name never opens a window on someone else's
//! voice.
//!
//! Discord sends nothing while someone is quiet. A gate fed only what arrives
//! would never see the silence that ends a command, and the spotter — which
//! needs a little audio after a word to be sure of it — would never finish
//! hearing a name said last. So the silence is put back: when a speaker has
//! sent nothing for a while, [`Speakers::tick`] feeds their gate zeros for the
//! time that passed. Only while it matters, though — a second after they went
//! quiet, or for as long as a command is open — so a call full of silent
//! listeners costs nothing.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::gate::{Gate, GateConfig, GateEvent};
use super::{FRAME_SAMPLES, Models, ModelError, to_float};

/// One frame's worth of time.
const FRAME: Duration = Duration::from_millis(20);
/// Arrival jitter tolerated before a gap is treated as silence.
const JITTER_FRAMES: u32 = 2;
/// Silence fed after someone stops, for the spotter to finish a word.
const FLUSH_FRAMES: u32 = 50;
/// Silence filled in one tick at most. A thread that stalled for longer than
/// this is behind, and a stretch of zeros will not help it catch up.
const MAX_FILL_FRAMES: u32 = 250;
/// A speaker unheard for this long has their models released.
const EVICT_AFTER: Duration = Duration::from_secs(600);

struct Speaker {
	gate: Gate,
	last_heard: Instant,
	/// Frames of silence fed since they last sent something.
	filled: u32,
}

/// The gates for one call.
pub struct Speakers {
	models: Arc<dyn Models>,
	config: GateConfig,
	speakers: HashMap<u64, Speaker>,
	samples: Vec<f32>,
	silence: Vec<f32>,
}

impl Speakers {
	pub fn new(models: Arc<dyn Models>, config: GateConfig) -> Self {
		Self {
			models,
			config,
			speakers: HashMap::new(),
			samples: Vec::with_capacity(FRAME_SAMPLES),
			silence: vec![0.0; FRAME_SAMPLES],
		}
	}

	/// How many speakers have a gate.
	pub fn len(&self) -> usize {
		self.speakers.len()
	}

	pub fn is_empty(&self) -> bool {
		self.speakers.is_empty()
	}

	/// Hear one frame from `user_id`.
	///
	/// Fails only if the models for a new speaker cannot be made, which the
	/// caller reports; the frame is lost either way.
	pub fn frame(
		&mut self,
		user_id: u64,
		pcm: &[i16],
		now: Instant,
		events: &mut dyn FnMut(u64, GateEvent),
	) -> Result<(), ModelError> {
		let Self { models, config, speakers, samples, .. } = self;
		to_float(pcm, samples);
		let speaker = speaker(speakers, models.as_ref(), *config, user_id, now)?;
		speaker.last_heard = now;
		speaker.filled = 0;
		speaker.gate.push(samples, &mut |event| events(user_id, event));
		Ok(())
	}

	/// Listen to `user_id` for a command without waiting for the name, as
	/// [`Gate::follow_up`] does. Fails only as [`Speakers::frame`] does.
	pub fn follow_up(
		&mut self,
		user_id: u64,
		keyword: &str,
		now: Instant,
		events: &mut dyn FnMut(u64, GateEvent),
	) -> Result<(), ModelError> {
		let speaker = speaker(&mut self.speakers, self.models.as_ref(), self.config, user_id, now)?;
		// The silence to fill starts now, not when they last spoke: that was
		// before the bot answered them, and counting it would close the window
		// as soon as it opened.
		speaker.last_heard = now;
		speaker.filled = 0;
		speaker.gate.follow_up(keyword, &mut |event| events(user_id, event));
		Ok(())
	}

	/// They left the call. Anything they were halfway through saying goes with
	/// them: a command from someone no longer there is not one to act on.
	pub fn left(&mut self, user_id: u64) {
		self.speakers.remove(&user_id);
	}

	/// Fill in the silence Discord did not send, and release anyone long gone.
	/// Call every frame or so.
	pub fn tick(&mut self, now: Instant, events: &mut dyn FnMut(u64, GateEvent)) {
		self.speakers.retain(|_, speaker| now.duration_since(speaker.last_heard) < EVICT_AFTER);
		for (&user_id, speaker) in &mut self.speakers {
			let quiet = now.duration_since(speaker.last_heard);
			let owed = ((quiet.as_millis() / FRAME.as_millis()) as u32).saturating_sub(JITTER_FRAMES);
			let mut fed = 0;
			while speaker.filled < owed
				&& fed < MAX_FILL_FRAMES
				&& (speaker.filled < FLUSH_FRAMES || !speaker.gate.is_listening())
			{
				speaker.gate.push(&self.silence, &mut |event| events(user_id, event));
				speaker.filled += 1;
				fed += 1;
			}
		}
	}
}

/// `user_id`'s entry, made with a gate of their own if they are new.
fn speaker<'a>(
	speakers: &'a mut HashMap<u64, Speaker>,
	models: &dyn Models,
	config: GateConfig,
	user_id: u64,
	now: Instant,
) -> Result<&'a mut Speaker, ModelError> {
	Ok(match speakers.entry(user_id) {
		std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
		std::collections::hash_map::Entry::Vacant(entry) => {
			entry.insert(Speaker { gate: Gate::new(config, models.spotter()?, models.vad()?), last_heard: now, filled: 0 })
		}
	})
}

#[cfg(test)]
mod tests {
	use super::super::gate::fakes::*;
	use super::super::{Spotter, Vad};
	use super::*;
	use std::sync::atomic::{AtomicUsize, Ordering};

	/// Counts what it makes, so tests can see models being made and released.
	struct FakeModels {
		made: AtomicUsize,
		lag: usize,
	}

	impl Models for FakeModels {
		fn spotter(&self) -> Result<Box<dyn Spotter>, ModelError> {
			self.made.fetch_add(1, Ordering::Relaxed);
			Ok(Box::new(FakeSpotter { lag: self.lag }))
		}

		fn vad(&self) -> Result<Box<dyn Vad>, ModelError> {
			Ok(Box::new(FakeVad))
		}
	}

	const ALICE: u64 = 1;
	const BOB: u64 = 2;

	fn speakers() -> Speakers {
		Speakers::new(Arc::new(FakeModels { made: AtomicUsize::new(0), lag: 0 }), GateConfig::default())
	}

	fn pcm(frame: &[f32]) -> Vec<i16> {
		frame.iter().map(|&sample| (sample * 32768.0) as i16).collect()
	}

	/// The fakes compare samples exactly, and 0.75 survives the trip through
	/// i16 and back.
	#[test]
	fn the_fake_keyword_survives_conversion() {
		let mut back = Vec::new();
		to_float(&pcm(&keyword_frame()), &mut back);
		assert!(back.contains(&KEYWORD));
	}

	struct Clock {
		now: Instant,
	}

	impl Clock {
		fn step(&mut self) -> Instant {
			self.now += FRAME;
			self.now
		}
	}

	type Heard = Vec<(u64, GateEvent)>;

	fn say(speakers: &mut Speakers, user: u64, frames: &[Vec<f32>], clock: &mut Clock, heard: &mut Heard) {
		for frame in frames {
			let now = clock.step();
			speakers.frame(user, &pcm(frame), now, &mut |user, event| heard.push((user, event))).unwrap();
			speakers.tick(now, &mut |user, event| heard.push((user, event)));
		}
	}

	/// Time passing with nobody sending anything.
	fn wait(speakers: &mut Speakers, frames: usize, clock: &mut Clock, heard: &mut Heard) {
		for _ in 0..frames {
			let now = clock.step();
			speakers.tick(now, &mut |user, event| heard.push((user, event)));
		}
	}

	fn captures(heard: &Heard) -> Vec<(u64, usize)> {
		heard
			.iter()
			.filter_map(|(user, event)| match event {
				GateEvent::Captured(capture) => Some((*user, capture.samples.len())),
				_ => None,
			})
			.collect()
	}

	#[test]
	fn silence_discord_never_sent_ends_the_command() {
		let mut speakers = speakers();
		let mut clock = Clock { now: Instant::now() };
		let mut heard = Vec::new();
		say(&mut speakers, ALICE, &[keyword_frame()], &mut clock, &mut heard);
		say(&mut speakers, ALICE, &frames(LOUD, 20), &mut clock, &mut heard);
		// Then nothing at all arrives.
		wait(&mut speakers, 40, &mut clock, &mut heard);
		assert_eq!(captures(&heard).len(), 1, "{heard:?}");
	}

	#[test]
	fn overlapping_speakers_are_kept_apart() {
		let mut speakers = speakers();
		let mut clock = Clock { now: Instant::now() };
		let mut heard = Vec::new();

		// Alice says the name while Bob talks over her; Bob never says it.
		for index in 0..60 {
			let frame = if index == 10 { keyword_frame() } else { vec![LOUD; FRAME_SAMPLES] };
			let alice = if index < 30 { Some(frame) } else { None };
			let now = clock.step();
			if let Some(frame) = alice {
				speakers.frame(ALICE, &pcm(&frame), now, &mut |u, e| heard.push((u, e))).unwrap();
			}
			speakers.frame(BOB, &pcm(&[LOUD; FRAME_SAMPLES]), now, &mut |u, e| heard.push((u, e))).unwrap();
			speakers.tick(now, &mut |u, e| heard.push((u, e)));
		}
		wait(&mut speakers, 40, &mut clock, &mut heard);

		assert_eq!(speakers.len(), 2);
		assert!(heard.iter().all(|(user, _)| *user == ALICE), "Bob's voice opened nothing: {heard:?}");
		// Alice's window holds her 19 frames after the name, not Bob's 50.
		let captured = captures(&heard);
		assert_eq!(captured.len(), 1);
		assert!(captured[0].1 < super::super::samples(1000), "{captured:?}");
	}

	#[test]
	fn leaving_mid_command_drops_it_and_frees_the_models() {
		let models = Arc::new(FakeModels { made: AtomicUsize::new(0), lag: 0 });
		let mut speakers = Speakers::new(models.clone(), GateConfig::default());
		let mut clock = Clock { now: Instant::now() };
		let mut heard = Vec::new();
		say(&mut speakers, ALICE, &[keyword_frame()], &mut clock, &mut heard);
		say(&mut speakers, ALICE, &frames(LOUD, 10), &mut clock, &mut heard);
		speakers.left(ALICE);
		wait(&mut speakers, 60, &mut clock, &mut heard);

		assert!(speakers.is_empty());
		assert!(captures(&heard).is_empty(), "{heard:?}");

		// Coming back starts from scratch.
		say(&mut speakers, ALICE, &frames(0.0, 1), &mut clock, &mut heard);
		assert_eq!(models.made.load(Ordering::Relaxed), 2);
	}

	#[test]
	fn a_quiet_speaker_stops_costing_anything() {
		let mut speakers = speakers();
		let mut clock = Clock { now: Instant::now() };
		let mut heard = Vec::new();
		say(&mut speakers, ALICE, &frames(LOUD, 5), &mut clock, &mut heard);
		wait(&mut speakers, 500, &mut clock, &mut heard);
		let speaker = &speakers.speakers[&ALICE];
		assert_eq!(speaker.filled, FLUSH_FRAMES, "only the flush is filled while idle");
	}

	#[test]
	fn a_name_said_last_is_still_heard_once_silence_is_filled() {
		// A spotter that, like a real one, only fires once it has heard some
		// audio after the word.
		struct LateSpotter {
			since_keyword: Option<usize>,
		}
		impl Spotter for LateSpotter {
			fn accept(&mut self, samples: &[f32]) -> Option<super::super::Detection> {
				if samples.contains(&KEYWORD) {
					self.since_keyword = Some(0);
					return None;
				}
				let since = self.since_keyword.as_mut()?;
				*since += samples.len();
				(*since >= super::super::samples(300)).then(|| super::super::Detection {
					keyword: "AMHRA".to_owned(),
					lag: *since,
				})
			}
			fn reset(&mut self) {
				self.since_keyword = None;
			}
		}
		struct LateModels;
		impl Models for LateModels {
			fn spotter(&self) -> Result<Box<dyn Spotter>, ModelError> {
				Ok(Box::new(LateSpotter { since_keyword: None }))
			}
			fn vad(&self) -> Result<Box<dyn Vad>, ModelError> {
				Ok(Box::new(FakeVad))
			}
		}

		let mut speakers = Speakers::new(Arc::new(LateModels), GateConfig::default());
		let mut clock = Clock { now: Instant::now() };
		let mut heard = Vec::new();
		say(&mut speakers, ALICE, &[keyword_frame()], &mut clock, &mut heard);
		wait(&mut speakers, 30, &mut clock, &mut heard);
		assert!(
			heard.iter().any(|(_, event)| matches!(event, GateEvent::Woke { .. })),
			"{heard:?}"
		);
	}

	#[test]
	fn a_follow_up_long_after_they_spoke_waits_for_them() {
		let mut speakers = speakers();
		let mut clock = Clock { now: Instant::now() };
		let mut heard = Vec::new();
		say(&mut speakers, ALICE, &frames(LOUD, 5), &mut clock, &mut heard);
		// The bot takes a while to answer.
		wait(&mut speakers, 300, &mut clock, &mut heard);
		let now = clock.step();
		speakers.follow_up(ALICE, "FOLLOW-UP", now, &mut |user, event| heard.push((user, event))).unwrap();
		wait(&mut speakers, 10, &mut clock, &mut heard);
		assert!(
			!heard.iter().any(|(_, event)| matches!(event, GateEvent::TimedOut { .. })),
			"the old silence did not count against the wait: {heard:?}"
		);
		say(&mut speakers, ALICE, &frames(LOUD, 20), &mut clock, &mut heard);
		wait(&mut speakers, 40, &mut clock, &mut heard);
		assert_eq!(captures(&heard).len(), 1, "{heard:?}");
	}

	#[test]
	fn long_gone_speakers_are_released() {
		let mut speakers = speakers();
		let mut clock = Clock { now: Instant::now() };
		let mut heard = Vec::new();
		say(&mut speakers, ALICE, &frames(LOUD, 1), &mut clock, &mut heard);
		clock.now += EVICT_AFTER;
		speakers.tick(clock.now, &mut |_, _| {});
		assert!(speakers.is_empty());
	}
}
