//! What a call hears when someone says the bot's name: a chime, and the music
//! lowered until what they said next has been heard. Then, with speech on,
//! the bot saying what it is doing, over the music lowered again.
//!
//! Both happen on the guild's audio thread, at the moment of the wake rather
//! than when the text reaches the bot, which is most of a second later. The
//! chime says "I'm listening" while there is still a command to say; the dip
//! keeps the music out of the way of it, and out of the recogniser's ear for
//! anyone without headphones.
//!
//! Three sounds mark a command's way through:
//!
//! ```text
//! "Amhra"  ─▶ start chime ─▶ they speak ─▶ end chime ─▶ waiting… waiting… ─▶ answer
//!             (rising)                    (falling)    (every 2s)
//! ```
//!
//! The waiting sound repeats until the bot answers for that speaker: by
//! saying something to them, or by telling the sidecar it is done.
//!
//! They are synthesised, not sound files: soft sine notes, rising for the
//! start the way an assistant answers to its name, falling for the end, and a
//! single low one while waiting. Nothing to ship, license or load.

use std::collections::VecDeque;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use amhra_audio::opus::{CHANNELS, FRAME_SIZE, SAMPLE_RATE};

/// One 20ms frame of interleaved stereo PCM.
pub const FRAME_PCM: usize = FRAME_SIZE as usize * CHANNELS as usize;

/// The longest the music stays down for one wake. A command is at most five
/// seconds after a two-second wait, and recognising it well under one; past
/// this, whatever was meant to bring the music back has been lost.
const MAX_DUCK: Duration = Duration::from_secs(10);

/// A synthesised sound: notes, each from a time in seconds at a pitch.
struct Sound {
	notes: &'static [(f32, f32)],
	/// How long the whole sound lasts.
	length: f32,
	/// Peak level, as a fraction of full scale. It is mixed over the music,
	/// which is lowered at the same moment, so it does not need to be loud.
	level: f32,
	/// How quickly a note fades: its level falls by e every this many seconds.
	decay: f32,
}

/// The name was heard: E6 then A6.
const START: Sound = Sound { notes: &[(0.0, 1318.51), (0.11, 1760.0)], length: 0.5, level: 0.18, decay: 0.14 };
/// What followed it has been taken down: the same notes, falling.
const END: Sound = Sound { notes: &[(0.0, 1760.0), (0.11, 1318.51)], length: 0.5, level: 0.15, decay: 0.14 };
/// Still working on it: one soft, low A5, short enough not to be talked over.
const WAITING: Sound = Sound { notes: &[(0.0, 880.0)], length: 0.3, level: 0.08, decay: 0.08 };

/// A note's rise, so it starts without a click.
const ATTACK: f32 = 0.004;
/// The last stretch, faded to nothing so a sound ends without a click.
const RELEASE: f32 = 0.03;

/// The start chime as interleaved stereo PCM at the Opus rate, rendered once.
pub fn chime() -> Arc<[i16]> {
	static CHIME: OnceLock<Arc<[i16]>> = OnceLock::new();
	Arc::clone(CHIME.get_or_init(|| render(&START).into()))
}

/// The end chime, rendered once.
pub fn end_chime() -> Arc<[i16]> {
	static CHIME: OnceLock<Arc<[i16]>> = OnceLock::new();
	Arc::clone(CHIME.get_or_init(|| render(&END).into()))
}

/// The waiting sound, rendered once.
pub fn waiting() -> Arc<[i16]> {
	static SOUND: OnceLock<Arc<[i16]>> = OnceLock::new();
	Arc::clone(SOUND.get_or_init(|| render(&WAITING).into()))
}

fn render(sound: &Sound) -> Vec<i16> {
	let rate = SAMPLE_RATE as f32;
	let frames = (sound.length * rate) as usize;
	let mut pcm = Vec::with_capacity(frames * CHANNELS as usize);
	for index in 0..frames {
		let t = index as f32 / rate;
		let mut value = 0.0;
		for &(start, pitch) in sound.notes {
			let since = t - start;
			if since < 0.0 {
				continue;
			}
			let envelope = (since / ATTACK).min(1.0) * (-since / sound.decay).exp();
			let phase = std::f32::consts::TAU * pitch * since;
			// A touch of the octave makes it a bell rather than a beep.
			value += envelope * (phase.sin() + 0.25 * (2.0 * phase).sin());
		}
		let release = ((sound.length - t) / RELEASE).min(1.0);
		// Two notes and their overtones peak a little above 1 together.
		let sample = (value / 1.6 * release * sound.level * f32::from(i16::MAX)) as i16;
		for _ in 0..CHANNELS {
			pcm.push(sample);
		}
	}
	pcm
}

/// Run when a clip has played out.
pub type Then = Box<dyn FnOnce() + Send>;

/// A sound being played over the music, a frame at a time: a chime, or
/// something the bot says.
pub struct Clip {
	pcm: Arc<[i16]>,
	at: usize,
	/// Lower the music to this while it plays.
	duck: Option<f32>,
	/// The speaker this answers: they are no longer waited on once it starts.
	answers: Option<u64>,
	/// What to do once it has been said, such as listen to them again.
	then: Option<Then>,
	started: bool,
}

impl std::fmt::Debug for Clip {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Clip")
			.field("samples", &self.pcm.len())
			.field("at", &self.at)
			.field("duck", &self.duck)
			.field("answers", &self.answers)
			.field("then", &self.then.is_some())
			.finish()
	}
}

impl Clip {
	pub fn chime() -> Self {
		Self::new(chime(), None)
	}

	pub fn end_chime() -> Self {
		Self::new(end_chime(), None)
	}

	pub fn waiting() -> Self {
		Self::new(waiting(), None)
	}

	/// `pcm`, interleaved stereo at the Opus rate, with the music lowered to
	/// `duck` under it if given.
	pub fn new(pcm: Arc<[i16]>, duck: Option<f32>) -> Self {
		Self { pcm, at: 0, duck, answers: None, then: None, started: false }
	}

	/// Said in answer to `user_id`, ending the wait for them when it starts.
	#[must_use]
	pub fn answering(mut self, user_id: u64) -> Self {
		self.answers = Some(user_id);
		self
	}

	/// Run `then` once this has played out.
	#[must_use]
	pub fn then(mut self, then: Then) -> Self {
		self.then = Some(then);
		self
	}

	/// The speaker this answers, if any.
	pub fn answers(&self) -> Option<u64> {
		self.answers
	}

	/// Fill `out` with the next frame, padding the last with silence. False
	/// once the clip is over.
	pub fn next_frame(&mut self, out: &mut [i16; FRAME_PCM]) -> bool {
		if self.at >= self.pcm.len() {
			return false;
		}
		let end = (self.at + FRAME_PCM).min(self.pcm.len());
		let filled = end - self.at;
		out[..filled].copy_from_slice(&self.pcm[self.at..end]);
		out[filled..].fill(0);
		self.at = end;
		true
	}
}

/// Clips waiting to be played, one after another: a chime is not talked over.
#[derive(Debug, Default)]
pub struct Clips {
	queue: VecDeque<Clip>,
}

/// More than this waiting and the newest is dropped: a backlog of what the
/// bot meant to say a while ago is worse than silence.
const MAX_QUEUED: usize = 4;

impl Clips {
	/// Queue `clip`, or hand it back if too much is queued already.
	pub fn push(&mut self, clip: Clip) -> Option<Clip> {
		if self.queue.len() < MAX_QUEUED {
			self.queue.push_back(clip);
			None
		} else {
			Some(clip)
		}
	}

	pub fn is_empty(&self) -> bool {
		self.queue.is_empty()
	}

	/// The next frame of whatever is playing into `out`, lowering the music
	/// through `duck` while a clip that asks for it plays, and ending the wait
	/// for whoever a clip answers as it starts. False when nothing is playing.
	pub fn next_frame(
		&mut self,
		out: &mut [i16; FRAME_PCM],
		duck: &mut Duck,
		waits: &mut Waits,
		now: Instant,
	) -> bool {
		while let Some(clip) = self.queue.front_mut() {
			if !clip.started {
				clip.started = true;
				// Answered first, so the music does not come up between the
				// wait ending and the answer lowering it again.
				if let Some(user_id) = clip.answers {
					waits.settle(user_id, duck);
				}
				if let Some(gain) = clip.duck {
					duck.woke(gain, now);
				}
			}
			if clip.next_frame(out) {
				return true;
			}
			let Some(clip) = self.queue.pop_front() else { break };
			if clip.duck.is_some() {
				duck.heard();
			}
			if let Some(then) = clip.then {
				then();
			}
		}
		false
	}
}

/// How often the waiting sound repeats.
pub const WAIT_EVERY: Duration = Duration::from_secs(2);
/// The longest anyone is waited on. Past this, whatever was meant to answer
/// them has been lost.
const MAX_WAIT: Duration = Duration::from_secs(20);

/// The speakers whose command has been taken down and not yet answered.
#[derive(Debug, Default)]
pub struct Waits {
	users: Vec<Wait>,
	/// When the waiting sound is next due, while it is to be heard at all.
	next: Option<Instant>,
}

#[derive(Debug)]
struct Wait {
	user_id: u64,
	/// When to give up on them.
	until: Instant,
	/// Whether they are holding the music down.
	ducked: bool,
}

impl Waits {
	/// `user_id`'s command has been taken down: hold the music at `gain`
	/// until they are answered, with the waiting sound every [`WAIT_EVERY`] if
	/// `sound`.
	pub fn start(&mut self, user_id: u64, sound: bool, gain: f32, duck: &mut Duck, now: Instant) {
		if let Some(wait) = self.users.iter_mut().find(|wait| wait.user_id == user_id) {
			wait.until = now + MAX_WAIT;
		} else {
			let ducked = gain < 1.0;
			if ducked {
				duck.woke(gain, now);
			}
			self.users.push(Wait { user_id, until: now + MAX_WAIT, ducked });
		}
		if sound && self.next.is_none() {
			self.next = Some(now + WAIT_EVERY);
		}
	}

	/// `user_id` has been answered, or nothing will answer them.
	pub fn settle(&mut self, user_id: u64, duck: &mut Duck) {
		self.release(duck, |wait| wait.user_id == user_id);
	}

	pub fn is_empty(&self) -> bool {
		self.users.is_empty()
	}

	/// Whether the waiting sound is due now. Gives up on anyone waited on too
	/// long. `busy` is something else being played: the sound is not queued
	/// behind it, but waits for its next turn.
	pub fn due(&mut self, busy: bool, duck: &mut Duck, now: Instant) -> bool {
		self.release(duck, |wait| now >= wait.until);
		let Some(next) = self.next else { return false };
		if now < next {
			return false;
		}
		self.next = Some(now + WAIT_EVERY);
		!busy
	}

	fn release(&mut self, duck: &mut Duck, done: impl Fn(&Wait) -> bool) {
		self.users.retain(|wait| {
			let done = done(wait);
			if done && wait.ducked {
				duck.heard();
			}
			!done
		});
		if self.users.is_empty() {
			self.next = None;
		}
	}
}

/// Whether the music is lowered, and by how much.
///
/// Counted, because two people can say the name at once: the first command
/// being heard must not bring the music back while the second is still being
/// said.
#[derive(Debug)]
pub struct Duck {
	gain: f32,
	open: u32,
	until: Option<Instant>,
}

impl Default for Duck {
	fn default() -> Self {
		Self { gain: 1.0, open: 0, until: None }
	}
}

impl Duck {
	/// Someone said the name: lower the music to `gain`.
	pub fn woke(&mut self, gain: f32, now: Instant) {
		self.gain = gain.clamp(0.0, 1.0);
		self.open += 1;
		self.until = Some(now + MAX_DUCK);
	}

	/// One wake has been dealt with: heard, timed out, or given up on.
	pub fn heard(&mut self) {
		self.open = self.open.saturating_sub(1);
		if self.open == 0 {
			self.until = None;
		}
	}

	/// What to multiply the music's gain by now.
	pub fn factor(&mut self, now: Instant) -> f32 {
		if self.until.is_some_and(|until| now >= until) {
			self.open = 0;
			self.until = None;
		}
		if self.open > 0 { self.gain } else { 1.0 }
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn seconds(pcm: &[i16]) -> f32 {
		pcm.len() as f32 / CHANNELS as f32 / SAMPLE_RATE as f32
	}

	fn frames_of(sound: &Sound) -> usize {
		(sound.length * 1000.0 / 20.0).ceil() as usize
	}

	#[test]
	fn each_sound_is_short_quiet_and_starts_and_ends_at_rest() {
		for (pcm, sound) in [(chime(), &START), (end_chime(), &END), (waiting(), &WAITING)] {
			let pcm = &pcm[..];
			assert!((seconds(pcm) - sound.length).abs() < 0.01, "{}s", seconds(pcm));
			let peak = pcm.iter().map(|sample| i32::from(*sample).abs()).max().unwrap();
			assert!(peak > 1_000, "audible: {peak}");
			assert!(peak <= (f32::from(i16::MAX) * sound.level) as i32 + 1, "not loud: {peak}");
			// No click at either end.
			assert!(pcm[..4].iter().all(|sample| sample.abs() < 200));
			assert!(pcm[pcm.len() - 4..].iter().all(|sample| sample.abs() < 200));
		}
	}

	#[test]
	fn the_end_chime_is_not_the_start_chime() {
		assert_ne!(&chime()[..], &end_chime()[..]);
		// Quieter than either chime: it repeats.
		const { assert!(WAITING.level < END.level && WAITING.length < END.length) };
	}

	#[test]
	fn the_chime_plays_out_in_whole_frames() {
		let mut chime = Clip::chime();
		let mut frame = [0i16; FRAME_PCM];
		let mut frames = 0;
		while chime.next_frame(&mut frame) {
			frames += 1;
		}
		assert_eq!(frames, frames_of(&START));
		assert!(!chime.next_frame(&mut frame), "and stays over");
	}

	#[test]
	fn clips_play_in_turn_with_the_music_down_under_speech() {
		let now = Instant::now();
		let mut duck = Duck::default();
		let mut waits = Waits::default();
		let mut clips = Clips::default();
		let mut frame = [0i16; FRAME_PCM];
		clips.push(Clip::chime());
		let speech: Arc<[i16]> = vec![1000; FRAME_PCM * 2].into();
		clips.push(Clip::new(speech, Some(0.3)));

		// The chime first, with the music where it was.
		for _ in 0..frames_of(&START) {
			assert!(clips.next_frame(&mut frame, &mut duck, &mut waits, now));
			assert_eq!(duck.factor(now), 1.0);
		}
		// Then the speech, over the music lowered.
		assert!(clips.next_frame(&mut frame, &mut duck, &mut waits, now));
		assert_eq!(frame[0], 1000);
		assert_eq!(duck.factor(now), 0.3);
		assert!(clips.next_frame(&mut frame, &mut duck, &mut waits, now));
		// And the music back once it is said.
		assert!(!clips.next_frame(&mut frame, &mut duck, &mut waits, now));
		assert_eq!(duck.factor(now), 1.0);
	}

	#[test]
	fn a_backlog_of_speech_is_dropped_and_handed_back() {
		let mut clips = Clips::default();
		for _ in 0..MAX_QUEUED {
			assert!(clips.push(Clip::chime()).is_none());
		}
		assert!(clips.push(Clip::chime()).is_some());
		assert_eq!(clips.queue.len(), MAX_QUEUED);
	}

	#[test]
	fn the_waiting_sound_repeats_until_the_answer_starts() {
		let start = Instant::now();
		let mut duck = Duck::default();
		let mut waits = Waits::default();
		waits.start(7, true, 0.3, &mut duck, start);
		assert_eq!(duck.factor(start), 0.3, "the music stays down while waiting");

		// Not straight away: the end chime has just played.
		assert!(!waits.due(false, &mut duck, start));
		assert!(waits.due(false, &mut duck, start + WAIT_EVERY));
		assert!(!waits.due(false, &mut duck, start + WAIT_EVERY));
		// A turn that finds something else playing is skipped, not queued.
		assert!(!waits.due(true, &mut duck, start + WAIT_EVERY * 2));
		assert!(waits.due(false, &mut duck, start + WAIT_EVERY * 3));

		// The answer starts: no more waiting, and it holds the music down.
		let mut clips = Clips::default();
		let mut frame = [0i16; FRAME_PCM];
		let answer: Arc<[i16]> = vec![1; FRAME_PCM].into();
		clips.push(Clip::new(answer, Some(0.3)).answering(7));
		let now = start + WAIT_EVERY * 3;
		assert!(clips.next_frame(&mut frame, &mut duck, &mut waits, now));
		assert!(waits.is_empty());
		assert_eq!(duck.factor(now), 0.3);
		assert!(!clips.next_frame(&mut frame, &mut duck, &mut waits, now));
		assert_eq!(duck.factor(now), 1.0);
		assert!(!waits.due(false, &mut duck, now + WAIT_EVERY * 10));
	}

	#[test]
	fn a_wait_nobody_answers_is_given_up_on() {
		let start = Instant::now();
		let mut duck = Duck::default();
		let mut waits = Waits::default();
		waits.start(7, true, 1.0, &mut duck, start);
		assert_eq!(duck.factor(start), 1.0, "a duck of 1 lowers nothing");
		waits.due(false, &mut duck, start + MAX_WAIT);
		assert!(waits.is_empty());
		// Settling someone not waited on is harmless.
		waits.settle(7, &mut duck);
		waits.settle(8, &mut duck);
	}

	#[test]
	fn a_silent_wait_still_holds_the_music() {
		let start = Instant::now();
		let mut duck = Duck::default();
		let mut waits = Waits::default();
		waits.start(7, false, 0.5, &mut duck, start);
		assert!(!waits.due(false, &mut duck, start + WAIT_EVERY));
		assert_eq!(duck.factor(start + WAIT_EVERY), 0.5);
		waits.settle(7, &mut duck);
		assert_eq!(duck.factor(start + WAIT_EVERY), 1.0);
	}

	#[test]
	fn what_follows_a_clip_runs_once_it_has_played() {
		let now = Instant::now();
		let mut duck = Duck::default();
		let mut waits = Waits::default();
		let mut clips = Clips::default();
		let mut frame = [0i16; FRAME_PCM];
		let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
		let flag = Arc::clone(&ran);
		let pcm: Arc<[i16]> = vec![1; FRAME_PCM * 2].into();
		clips.push(Clip::new(pcm, None).then(Box::new(move || flag.store(true, std::sync::atomic::Ordering::Relaxed))));
		assert!(clips.next_frame(&mut frame, &mut duck, &mut waits, now));
		assert!(clips.next_frame(&mut frame, &mut duck, &mut waits, now));
		assert!(!ran.load(std::sync::atomic::Ordering::Relaxed), "not while it is still being said");
		assert!(!clips.next_frame(&mut frame, &mut duck, &mut waits, now));
		assert!(ran.load(std::sync::atomic::Ordering::Relaxed));
	}

	#[test]
	fn the_music_comes_back_once_every_wake_is_dealt_with() {
		let now = Instant::now();
		let mut duck = Duck::default();
		assert_eq!(duck.factor(now), 1.0);

		duck.woke(0.3, now);
		duck.woke(0.3, now);
		assert_eq!(duck.factor(now), 0.3);
		duck.heard();
		assert_eq!(duck.factor(now), 0.3, "one speaker is still talking");
		duck.heard();
		assert_eq!(duck.factor(now), 1.0);
		// An extra one is harmless.
		duck.heard();
		assert_eq!(duck.factor(now), 1.0);
	}

	#[test]
	fn a_lost_ending_does_not_leave_the_music_down() {
		let now = Instant::now();
		let mut duck = Duck::default();
		duck.woke(0.3, now);
		assert_eq!(duck.factor(now + MAX_DUCK / 2), 0.3);
		assert_eq!(duck.factor(now + MAX_DUCK), 1.0);
		// And the count started over.
		duck.woke(0.5, now + MAX_DUCK);
		duck.heard();
		assert_eq!(duck.factor(now + MAX_DUCK), 1.0);
	}
}
