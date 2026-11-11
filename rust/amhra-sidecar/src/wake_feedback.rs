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
//! "Amhra"  ─▶ start chime ─▶ they speak ─▶ end chime ─▶ processing ─▶ answer
//!           (start.wav)                  (end.wav)  (waiting.wav,
//!                                                      once)
//! ```
//!
//! Overlapping requests share one processing sound. Ready answers interrupt
//! it and play in turn; start and end chimes mix over all other audio.
//!
//! They are sound files in `assets/sounds`, built into the binary: 48kHz
//! stereo 16-bit PCM WAV, the rate and layout the call is sent at, so they
//! play as they are. Each is scaled to a set peak level, since it is mixed
//! over the music, and gets a short fade at either end so it cannot click.

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

/// The name was heard.
const START: &[u8] = include_bytes!("../assets/sounds/start.wav");
/// What followed it has been taken down.
const END: &[u8] = include_bytes!("../assets/sounds/end.wav");
/// Still working on it.
const WAITING: &[u8] = include_bytes!("../assets/sounds/waiting.wav");

/// Peak levels, as a fraction of full scale. They are mixed over the music,
/// which is lowered at the same moment, so they need not be loud; the
/// waiting sound is quietest, being background feedback.
const START_LEVEL: f32 = 0.18;
const END_LEVEL: f32 = 0.15;
const WAITING_LEVEL: f32 = 0.08;

/// The fade in at the start of a sound, so it starts without a click.
const ATTACK: f32 = 0.004;
/// The fade out at the end, so it ends without a click.
const RELEASE: f32 = 0.03;

/// The start chime as interleaved stereo PCM at the Opus rate, decoded once.
pub fn chime() -> Arc<[i16]> {
	static CHIME: OnceLock<Arc<[i16]>> = OnceLock::new();
	Arc::clone(CHIME.get_or_init(|| load(START, "start.wav", START_LEVEL)))
}

/// The end chime, decoded once.
pub fn end_chime() -> Arc<[i16]> {
	static CHIME: OnceLock<Arc<[i16]>> = OnceLock::new();
	Arc::clone(CHIME.get_or_init(|| load(END, "end.wav", END_LEVEL)))
}

/// The waiting sound, decoded once.
pub fn waiting() -> Arc<[i16]> {
	static SOUND: OnceLock<Arc<[i16]>> = OnceLock::new();
	Arc::clone(SOUND.get_or_init(|| load(WAITING, "waiting.wav", WAITING_LEVEL)))
}

fn load(wav: &[u8], name: &str, level: f32) -> Arc<[i16]> {
	let mut pcm = decode(wav).unwrap_or_else(|error| panic!("assets/sounds/{name}: {error}"));
	scale(&mut pcm, level);
	fade(&mut pcm);
	pcm.into()
}

/// The samples of a 16-bit PCM WAV at the call's rate and channel count.
fn decode(wav: &[u8]) -> Result<Vec<i16>, String> {
	if wav.len() < 12 || &wav[..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
		return Err("not a WAV file".into());
	}
	let u16_at = |at: usize| u16::from_le_bytes([wav[at], wav[at + 1]]);
	let u32_at = |at: usize| u32::from_le_bytes([wav[at], wav[at + 1], wav[at + 2], wav[at + 3]]);
	let mut format = None;
	let mut at = 12;
	while at + 8 <= wav.len() {
		let id = &wav[at..at + 4];
		let size = u32_at(at + 4) as usize;
		let body = at + 8;
		let end = body.checked_add(size).filter(|end| *end <= wav.len()).ok_or("a chunk runs past the end")?;
		match id {
			b"fmt " if size >= 16 => {
				format = Some((u16_at(body), u16_at(body + 2), u32_at(body + 4), u16_at(body + 14)));
			}
			b"data" => {
				let expected = (1, u16::from(CHANNELS), SAMPLE_RATE, 16);
				match format {
					Some(found) if found == expected => {}
					Some((tag, channels, rate, bits)) => {
						return Err(format!(
							"format {tag}, {channels} channels, {rate}Hz, {bits} bits; needs PCM, {CHANNELS} channels, {SAMPLE_RATE}Hz, 16 bits"
						));
					}
					None => return Err("no format before the samples".into()),
				}
				return Ok(wav[body..end].as_chunks::<2>().0.iter().map(|pair| i16::from_le_bytes(*pair)).collect());
			}
			_ => {}
		}
		// Chunks are padded to an even length.
		at = end + (size & 1);
	}
	Err("no samples".into())
}

/// Scale `pcm` so its loudest sample is `level` of full scale.
fn scale(pcm: &mut [i16], level: f32) {
	let peak = pcm.iter().map(|sample| i32::from(*sample).abs()).max().unwrap_or(0);
	if peak == 0 {
		return;
	}
	let gain = level * f32::from(i16::MAX) / peak as f32;
	for sample in pcm {
		*sample = (f32::from(*sample) * gain).round() as i16;
	}
}

/// Fade the first [`ATTACK`] and last [`RELEASE`] seconds of `pcm`.
fn fade(pcm: &mut [i16]) {
	let channels = CHANNELS as usize;
	let frames = pcm.len() / channels;
	let attack = ((ATTACK * SAMPLE_RATE as f32) as usize).max(1);
	let release = ((RELEASE * SAMPLE_RATE as f32) as usize).max(1);
	for (index, frame) in pcm.chunks_exact_mut(channels).enumerate() {
		let from_end = frames - 1 - index;
		let gain = (index as f32 / attack as f32).min(from_end as f32 / release as f32).min(1.0);
		if gain < 1.0 {
			for sample in frame {
				*sample = (f32::from(*sample) * gain) as i16;
			}
		}
	}
}

/// Run when a clip has played out.
pub type Then = Box<dyn FnOnce() + Send>;

#[derive(Debug, PartialEq, Eq)]
enum Kind {
	Speech,
	Cue,
	Processing,
}

/// A sound being played over the music, a frame at a time.
pub struct Clip {
	kind: Kind,
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
		Self { kind: Kind::Cue, ..Self::new(chime(), None) }
	}

	pub fn end_chime() -> Self {
		Self { kind: Kind::Cue, ..Self::new(end_chime(), None) }
	}

	pub fn waiting() -> Self {
		Self { kind: Kind::Processing, ..Self::new(waiting(), None) }
	}

	/// `pcm`, interleaved stereo at the Opus rate, with the music lowered to
	/// `duck` under it if given.
	pub fn new(pcm: Arc<[i16]>, duck: Option<f32>) -> Self {
		Self { kind: Kind::Speech, pcm, at: 0, duck, answers: None, then: None, started: false }
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

/// Speech plays in order; recording cues mix independently over it.
#[derive(Debug, Default)]
pub struct Clips {
	queue: VecDeque<Clip>,
	cues: Vec<Clip>,
	processing: Option<Clip>,
}

impl Clips {
	pub fn push(&mut self, clip: Clip) {
		match clip.kind {
			Kind::Cue => self.cues.push(clip),
			Kind::Processing => {
				if self.queue.is_empty() && self.processing.is_none() {
					self.processing = Some(clip);
				}
			}
			Kind::Speech => {
				self.processing = None;
				self.queue.push_back(clip);
			}
		}
	}

	/// Recording cues never block processing audio.
	pub fn processing_busy(&self) -> bool {
		!self.queue.is_empty() || self.processing.is_some()
	}

	/// The next frame of whatever is playing into `out`, lowering the music
	/// through `duck` while a clip that asks for it plays, and ending the wait
	/// for whoever a clip answers as it starts. False when nothing is playing.
	pub fn next_frame(&mut self, out: &mut [i16; FRAME_PCM], duck: &mut Duck, waits: &mut Waits, now: Instant) -> bool {
		let mut playing = false;
		out.fill(0);
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
				playing = true;
				break;
			}
			let Some(clip) = self.queue.pop_front() else { break };
			if clip.duck.is_some() {
				duck.heard();
			}
			if let Some(then) = clip.then {
				then();
			}
		}
		if waits.is_empty() {
			self.processing = None;
		}
		if let Some(clip) = self.processing.as_mut() {
			if clip.next_frame(out) {
				playing = true;
			} else {
				self.processing = None;
			}
		}
		if self.cues.is_empty() {
			return playing;
		}
		// Sum before clamping so concurrent cues do not wrap or clip each other
		// before the final mix is known.
		let mut mixed = out.map(i32::from);
		let mut cue_frame = [0i16; FRAME_PCM];
		self.cues.retain_mut(|cue| {
			if !cue.next_frame(&mut cue_frame) {
				return false;
			}
			playing = true;
			for (sample, cue) in mixed.iter_mut().zip(cue_frame) {
				*sample += i32::from(cue);
			}
			true
		});
		for (sample, mixed) in out.iter_mut().zip(mixed) {
			*sample = mixed.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16;
		}
		playing
	}
}

/// Delay before the single processing sound.
pub const WAIT_EVERY: Duration = Duration::from_secs(2);
/// The longest anyone is waited on. Past this, whatever was meant to answer
/// them has been lost.
const MAX_WAIT: Duration = Duration::from_secs(20);

/// The speakers whose command has been taken down and not yet answered.
#[derive(Debug, Default)]
pub struct Waits {
	users: Vec<Wait>,
	/// When this batch's processing sound is due.
	next: Option<Instant>,
	/// Prevent additional captures from restarting the sound during this batch.
	sounded: bool,
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
	/// until they are answered, with one waiting sound after [`WAIT_EVERY`] if
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
		if sound && !self.sounded && self.next.is_none() {
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
		if now < next || busy {
			return false;
		}
		self.next = None;
		self.sounded = true;
		true
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
			self.sounded = false;
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

	fn frames_of(pcm: &[i16]) -> usize {
		pcm.len().div_ceil(FRAME_PCM)
	}

	#[test]
	fn each_sound_decodes_and_starts_and_ends_at_rest() {
		for (pcm, level) in [(chime(), START_LEVEL), (end_chime(), END_LEVEL), (waiting(), WAITING_LEVEL)] {
			let pcm = &pcm[..];
			assert!(seconds(pcm) > 0.2 && seconds(pcm) < 3.0, "{}s", seconds(pcm));
			let peak = pcm.iter().map(|sample| i32::from(*sample).abs()).max().unwrap();
			let target = level * f32::from(i16::MAX);
			assert!((peak as f32 - target).abs() <= 1.0, "peak {peak}, wanted {target}");
			// No click at either end.
			assert!(pcm[..4].iter().all(|sample| sample.abs() < 200));
			assert!(pcm[pcm.len() - 4..].iter().all(|sample| sample.abs() < 200));
		}
	}

	#[test]
	fn the_end_chime_is_not_the_start_chime() {
		assert_ne!(&chime()[..], &end_chime()[..]);
		assert_ne!(&waiting()[..], &end_chime()[..]);
	}

	#[test]
	fn a_wav_in_another_format_is_refused() {
		let mut wav = START.to_vec();
		// The channel count, in the fmt chunk.
		wav[22] = 1;
		assert!(decode(&wav).unwrap_err().contains("1 channels"));
		assert!(decode(b"RIFF\0\0\0\0WAVE").is_err());
		assert!(decode(b"not a wav").is_err());
	}

	#[test]
	fn the_chime_plays_out_in_whole_frames() {
		let mut chime = Clip::chime();
		let mut frame = [0i16; FRAME_PCM];
		let mut frames = 0;
		while chime.next_frame(&mut frame) {
			frames += 1;
		}
		assert_eq!(frames, frames_of(&super::chime()));
		assert!(!chime.next_frame(&mut frame), "and stays over");
	}

	#[test]
	fn speech_is_queued_without_dropping_responses() {
		let now = Instant::now();
		let mut duck = Duck::default();
		let mut waits = Waits::default();
		let mut clips = Clips::default();
		let mut frame = [0i16; FRAME_PCM];
		for user in 1..=8 {
			waits.start(user, true, 0.3, &mut duck, now);
			clips.push(Clip::new(vec![user as i16; FRAME_PCM * 2].into(), Some(0.3)).answering(user));
		}
		for user in 1..=8 {
			for _ in 0..2 {
				assert!(clips.next_frame(&mut frame, &mut duck, &mut waits, now));
				assert!(frame.iter().all(|sample| *sample == user));
				assert_eq!(duck.factor(now), 0.3);
			}
		}
		assert!(!clips.next_frame(&mut frame, &mut duck, &mut waits, now));
		assert!(waits.is_empty());
		assert_eq!(duck.factor(now), 1.0);
	}

	#[test]
	fn recording_cues_mix_over_speech_and_each_other() {
		let now = Instant::now();
		let mut duck = Duck::default();
		let mut waits = Waits::default();
		let mut clips = Clips::default();
		let mut frame = [0i16; FRAME_PCM];
		clips.push(Clip::new(vec![1000; FRAME_PCM * 30].into(), None));
		assert!(clips.next_frame(&mut frame, &mut duck, &mut waits, now));
		// Cues arriving during speech start together on the very next frame.
		clips.push(Clip::chime());
		clips.push(Clip::end_chime());
		let (start, end) = (chime(), end_chime());
		let at_or_silence = |pcm: &[i16], at: usize| pcm.get(at).copied().map_or(0, i32::from);
		for index in 0..frames_of(&start).max(frames_of(&end)) {
			assert!(clips.next_frame(&mut frame, &mut duck, &mut waits, now));
			for (offset, sample) in frame.iter().enumerate() {
				let at = index * FRAME_PCM + offset;
				// Speech lasts 30 frames; past it, only the cues.
				let speech = if index < 29 { 1000 } else { 0 };
				let expected = (speech + at_or_silence(&start, at) + at_or_silence(&end, at)).clamp(i32::from(i16::MIN), i32::from(i16::MAX));
				assert_eq!(i32::from(*sample), expected);
			}
		}
	}

	#[test]
	fn a_ready_answer_interrupts_processing_but_not_recording_cues() {
		let now = Instant::now();
		let mut duck = Duck::default();
		let mut waits = Waits::default();
		let mut clips = Clips::default();
		let mut frame = [0i16; FRAME_PCM];
		waits.start(1, true, 0.3, &mut duck, now);
		waits.start(2, true, 0.3, &mut duck, now);
		clips.push(Clip::waiting());
		clips.push(Clip::waiting());
		assert!(clips.next_frame(&mut frame, &mut duck, &mut waits, now));
		assert_eq!(frame.as_slice(), &waiting()[..FRAME_PCM]);
		clips.push(Clip::new(vec![1000; FRAME_PCM].into(), None).answering(1));
		clips.push(Clip::chime());
		assert!(clips.next_frame(&mut frame, &mut duck, &mut waits, now));
		assert!(clips.processing.is_none());
		for (sample, cue) in frame.iter().zip(chime().iter()) {
			assert_eq!(i32::from(*sample), (1000 + i32::from(*cue)).min(i32::from(i16::MAX)));
		}
		assert!(!waits.is_empty(), "the second user is still waiting");
	}

	#[test]
	fn overlapping_requests_share_one_processing_cycle() {
		let start = Instant::now();
		let mut duck = Duck::default();
		let mut waits = Waits::default();
		waits.start(7, true, 0.3, &mut duck, start);
		assert_eq!(duck.factor(start), 0.3, "the music stays down while waiting");

		// Not straight away: the end chime has just played.
		assert!(!waits.due(false, &mut duck, start));
		assert!(waits.due(false, &mut duck, start + WAIT_EVERY));
		assert!(!waits.due(false, &mut duck, start + WAIT_EVERY));
		waits.start(8, true, 0.3, &mut duck, start + WAIT_EVERY);
		for cycle in 2..=5 {
			assert!(!waits.due(false, &mut duck, start + WAIT_EVERY * cycle));
		}
		waits.settle(8, &mut duck);

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
	fn a_new_batch_can_process_once_and_busy_speech_delays_it() {
		let now = Instant::now();
		let mut duck = Duck::default();
		let mut waits = Waits::default();
		waits.start(1, true, 0.3, &mut duck, now);
		assert!(!waits.due(true, &mut duck, now + WAIT_EVERY));
		assert!(waits.due(false, &mut duck, now + WAIT_EVERY * 2));
		assert!(!waits.due(false, &mut duck, now + WAIT_EVERY * 3));
		waits.settle(1, &mut duck);
		let next = now + WAIT_EVERY * 4;
		waits.start(2, true, 0.3, &mut duck, next);
		assert!(waits.due(false, &mut duck, next + WAIT_EVERY));
		assert!(!waits.due(false, &mut duck, next + WAIT_EVERY * 2));
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
