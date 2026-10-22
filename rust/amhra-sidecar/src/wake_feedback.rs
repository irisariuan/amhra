//! What a call hears when someone says the bot's name: a chime, and the music
//! lowered until what they said next has been heard.
//!
//! Both happen on the guild's audio thread, at the moment of the wake rather
//! than when the text reaches the bot, which is most of a second later. The
//! chime says "I'm listening" while there is still a command to say; the dip
//! keeps the music out of the way of it, and out of the recogniser's ear for
//! anyone without headphones.
//!
//! The chime is synthesised, not a sound file: two soft sine notes a fourth
//! apart, rising, the way an assistant answers to its name. Nothing to ship,
//! license or load.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use amhra_audio::opus::{CHANNELS, FRAME_SIZE, SAMPLE_RATE};

/// One 20ms frame of interleaved stereo PCM.
pub const FRAME_PCM: usize = FRAME_SIZE as usize * CHANNELS as usize;

/// The longest the music stays down for one wake. A command is at most five
/// seconds after a two-second wait, and recognising it well under one; past
/// this, whatever was meant to bring the music back has been lost.
const MAX_DUCK: Duration = Duration::from_secs(10);

/// The notes: when each starts, in seconds, and its pitch. E6 then A6.
const NOTES: [(f32, f32); 2] = [(0.0, 1318.51), (0.11, 1760.0)];
/// How long the whole chime lasts.
const LENGTH: f32 = 0.5;
/// Peak level, as a fraction of full scale. It is mixed over the music, which
/// is lowered at the same moment, so it does not need to be loud.
const LEVEL: f32 = 0.18;
/// A note's rise, so it starts without a click.
const ATTACK: f32 = 0.004;
/// How quickly a note fades: its level falls by e every this many seconds.
const DECAY: f32 = 0.14;
/// The last stretch, faded to nothing so the chime ends without a click.
const RELEASE: f32 = 0.03;

/// The chime as interleaved stereo PCM at the Opus rate, rendered once.
pub fn chime() -> &'static [i16] {
	static CHIME: OnceLock<Vec<i16>> = OnceLock::new();
	CHIME.get_or_init(render)
}

fn render() -> Vec<i16> {
	let rate = SAMPLE_RATE as f32;
	let frames = (LENGTH * rate) as usize;
	let mut pcm = Vec::with_capacity(frames * CHANNELS as usize);
	for index in 0..frames {
		let t = index as f32 / rate;
		let mut value = 0.0;
		for (start, pitch) in NOTES {
			let since = t - start;
			if since < 0.0 {
				continue;
			}
			let envelope = (since / ATTACK).min(1.0) * (-since / DECAY).exp();
			let phase = std::f32::consts::TAU * pitch * since;
			// A touch of the octave makes it a bell rather than a beep.
			value += envelope * (phase.sin() + 0.25 * (2.0 * phase).sin());
		}
		let release = ((LENGTH - t) / RELEASE).min(1.0);
		// Two notes and their overtones peak a little above 1 together.
		let sample = (value / 1.6 * release * LEVEL * f32::from(i16::MAX)) as i16;
		for _ in 0..CHANNELS {
			pcm.push(sample);
		}
	}
	pcm
}

/// A chime being played, a frame at a time.
#[derive(Debug, Default)]
pub struct Chime {
	at: usize,
}

impl Chime {
	/// Fill `out` with the next frame, padding the last with silence. False
	/// once the chime is over.
	pub fn next_frame(&mut self, out: &mut [i16; FRAME_PCM]) -> bool {
		let pcm = chime();
		if self.at >= pcm.len() {
			return false;
		}
		let end = (self.at + FRAME_PCM).min(pcm.len());
		let filled = end - self.at;
		out[..filled].copy_from_slice(&pcm[self.at..end]);
		out[filled..].fill(0);
		self.at = end;
		true
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

	#[test]
	fn the_chime_is_short_quiet_and_starts_and_ends_at_rest() {
		let pcm = chime();
		let seconds = pcm.len() as f32 / CHANNELS as f32 / SAMPLE_RATE as f32;
		assert!((seconds - LENGTH).abs() < 0.01, "{seconds}s");
		let peak = pcm.iter().map(|sample| i32::from(*sample).abs()).max().unwrap();
		assert!(peak > 2_000, "audible: {peak}");
		assert!(peak <= (f32::from(i16::MAX) * LEVEL) as i32 + 1, "not loud: {peak}");
		// No click at either end.
		assert!(pcm[..4].iter().all(|sample| sample.abs() < 200));
		assert!(pcm[pcm.len() - 4..].iter().all(|sample| sample.abs() < 200));
	}

	#[test]
	fn the_chime_plays_out_in_whole_frames() {
		let mut chime = Chime::default();
		let mut frame = [0i16; FRAME_PCM];
		let mut frames = 0;
		while chime.next_frame(&mut frame) {
			frames += 1;
		}
		assert_eq!(frames, (LENGTH * 1000.0 / 20.0).ceil() as usize);
		assert!(!chime.next_frame(&mut frame), "and stays over");
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
