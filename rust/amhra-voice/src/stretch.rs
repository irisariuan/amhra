//! Playback speed without a pitch change.
//!
//! WSOLA, sized so that one step is one Opus frame: each 20ms of output is the
//! tail of what played last, faded out, laid over a 20ms piece of the input
//! faded in. The piece is taken from near where the speed says playback should
//! be by now, nudged by up to 5ms to wherever it lines up best with the tail,
//! so the two halves of the overlap are in phase and the seam does not comb.
//!
//! Faster skips input between pieces, slower repeats it. Neither changes the
//! rate the samples are played at, so the pitch stays where it was.
//!
//! This is only PCM in and PCM out: the player decodes into it and encodes what
//! comes out, and at speed 1 it is not built at all.

use std::f32::consts::PI;

use amhra_audio::opus::{CHANNELS, FRAME_SIZE};

/// One step of output, per channel: exactly one Opus frame.
pub const HOP: usize = FRAME_SIZE as usize;

/// How far either way the piece may move to line up with the tail, per
/// channel. 5ms covers a period of anything above 200Hz, which is where the
/// comb filtering of a misaligned overlap is heard.
const SEEK: usize = 240;

/// Slowest and fastest speeds the stretcher takes. Zero is the player's to
/// handle (it plays nothing); anything slower than this is held here.
pub const MIN_SPEED: f64 = 0.01;
pub const MAX_SPEED: f64 = 10.0;

const STEREO: usize = CHANNELS as usize;

/// Input is dropped once this much of it is behind everything still needed,
/// per channel, so the buffer is moved a few times a second rather than every
/// frame.
const TRIM_AFTER: usize = HOP * 8;

pub struct Stretcher {
	/// Interleaved stereo, from the oldest sample still needed.
	input: Vec<f32>,
	/// Where playback should be by now, in frames from the start of `input`.
	position: f64,
	/// The sample that would naturally follow the last output, or `None`
	/// before the first output.
	tail: Option<usize>,
	speed: f64,
	fade_in: Vec<f32>,
}

impl std::fmt::Debug for Stretcher {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Stretcher")
			.field("speed", &self.speed)
			.field("buffered", &self.frames())
			.finish_non_exhaustive()
	}
}

impl Stretcher {
	pub fn new(speed: f64) -> Self {
		// A raised cosine, so the fade in and the fade out sum to exactly one.
		let fade_in = (0..HOP).map(|i| 0.5 - 0.5 * (PI * (i as f32 + 0.5) / HOP as f32).cos()).collect();
		Self { input: Vec::new(), position: 0.0, tail: None, speed: clamp(speed), fade_in }
	}

	pub fn speed(&self) -> f64 {
		self.speed
	}

	/// Takes effect from the next frame out.
	pub fn set_speed(&mut self, speed: f64) {
		self.speed = clamp(speed);
	}

	/// Forget everything buffered, as after a seek.
	pub fn reset(&mut self) {
		self.input.clear();
		self.position = 0.0;
		self.tail = None;
	}

	/// Add decoded interleaved stereo PCM.
	pub fn push(&mut self, pcm: &[i16]) {
		self.input.extend(pcm.iter().map(|&sample| sample as f32));
	}

	/// Frames per channel buffered.
	fn frames(&self) -> usize {
		self.input.len() / STEREO
	}

	/// The input the next output reads up to, per channel.
	fn needed(&self) -> usize {
		let nominal = self.position.round() as usize;
		let piece = match self.tail {
			None => nominal + HOP,
			Some(_) => nominal + SEEK + HOP,
		};
		piece.max(self.tail.map_or(0, |tail| tail + HOP))
	}

	/// Whether `next_frame` would produce one now.
	pub fn ready(&self) -> bool {
		self.frames() >= self.needed()
	}

	/// Write the next 20ms of output, interleaved stereo, into `out`, which
	/// must hold at least `HOP * 2` samples. False when more input is needed.
	pub fn next_frame(&mut self, out: &mut [i16]) -> bool {
		if !self.ready() {
			return false;
		}
		let nominal = self.position.round() as usize;
		let out = &mut out[..HOP * STEREO];
		match self.tail {
			// The first frame has nothing to line up with, so it is the input
			// as it is.
			None => {
				for (o, &sample) in out.iter_mut().zip(&self.input[nominal * STEREO..(nominal + HOP) * STEREO]) {
					*o = to_i16(sample);
				}
				self.tail = Some(nominal + HOP);
			}
			Some(tail) => {
				let best = self.best_offset(tail, nominal);
				for i in 0..HOP {
					let fade_in = self.fade_in[i];
					for channel in 0..STEREO {
						let old = self.input[(tail + i) * STEREO + channel];
						let new = self.input[(best + i) * STEREO + channel];
						out[i * STEREO + channel] = to_i16(old * (1.0 - fade_in) + new * fade_in);
					}
				}
				self.tail = Some(best + HOP);
			}
		}
		self.position += self.speed * HOP as f64;
		self.trim();
		true
	}

	/// Where near `nominal` a piece best continues what starts at `tail`.
	///
	/// Searched coarse then fine, on the two channels summed: every 4th
	/// candidate scored on every 4th sample, then the few around the winner on
	/// every 2nd. A full search would be 481 candidates by 960 samples a frame.
	fn best_offset(&self, tail: usize, nominal: usize) -> usize {
		let low = nominal.saturating_sub(SEEK);
		let high = nominal + SEEK;
		// The tail itself goes first when it is in reach, so a tie keeps the
		// input running on unbroken.
		let mut best = if (low..=high).contains(&tail) {
			(tail, self.similarity(tail, tail, 4))
		} else {
			(nominal, f32::MIN)
		};
		let mut candidate = low;
		while candidate <= high {
			let score = self.similarity(tail, candidate, 4);
			if score > best.1 {
				best = (candidate, score);
			}
			candidate += 4;
		}
		let coarse = best.0;
		best.1 = self.similarity(tail, coarse, 2);
		for candidate in coarse.saturating_sub(3).max(low)..=(coarse + 3).min(high) {
			let score = self.similarity(tail, candidate, 2);
			if score > best.1 {
				best = (candidate, score);
			}
		}
		best.0
	}

	/// Normalised cross-correlation of the piece at `candidate` against the
	/// one at `tail`, sampling every `stride` frames.
	fn similarity(&self, tail: usize, candidate: usize, stride: usize) -> f32 {
		let (mut cross, mut energy) = (0.0f32, 0.0f32);
		let mut i = 0;
		while i < HOP {
			let a = self.input[(tail + i) * STEREO] + self.input[(tail + i) * STEREO + 1];
			let b = self.input[(candidate + i) * STEREO] + self.input[(candidate + i) * STEREO + 1];
			cross += a * b;
			energy += b * b;
			i += stride;
		}
		// Silence scores zero rather than dividing by it.
		if energy <= f32::EPSILON { 0.0 } else { cross / energy.sqrt() }
	}

	/// Drop input nothing will read again.
	fn trim(&mut self) {
		let nominal = self.position.round() as usize;
		let keep_from = nominal.saturating_sub(SEEK).min(self.tail.unwrap_or(usize::MAX));
		if keep_from < TRIM_AFTER {
			return;
		}
		self.input.drain(..keep_from * STEREO);
		self.position -= keep_from as f64;
		self.tail = self.tail.map(|tail| tail - keep_from);
	}
}

fn clamp(speed: f64) -> f64 {
	if speed.is_finite() { speed.clamp(MIN_SPEED, MAX_SPEED) } else { 1.0 }
}

fn to_i16(sample: f32) -> i16 {
	sample.round().clamp(i16::MIN as f32, i16::MAX as f32) as i16
}

#[cfg(test)]
mod tests {
	use super::*;

	/// `frames` of a stereo sine at `hz`, from sample `start`.
	fn sine(hz: f32, start: usize, frames: usize) -> Vec<i16> {
		(start..start + frames)
			.flat_map(|n| {
				let value = (8000.0 * (2.0 * PI * hz * n as f32 / 48_000.0).sin()) as i16;
				[value, value]
			})
			.collect()
	}

	/// Run `seconds` of a sine through at `speed`, returning the output and
	/// how much input it took.
	fn run(speed: f64, seconds: usize) -> (Vec<i16>, usize) {
		let mut stretcher = Stretcher::new(speed);
		let mut out = Vec::new();
		let mut frame = vec![0i16; HOP * STEREO];
		let mut fed = 0;
		for _ in 0..seconds * 50 {
			while !stretcher.ready() {
				stretcher.push(&sine(440.0, fed, HOP));
				fed += HOP;
			}
			assert!(stretcher.next_frame(&mut frame));
			out.extend_from_slice(&frame);
		}
		(out, fed)
	}

	/// Crossings of zero going up, per second of stereo output.
	fn pitch(out: &[i16]) -> f32 {
		let left: Vec<i16> = out.iter().step_by(2).copied().collect();
		let rising = left.windows(2).filter(|pair| pair[0] < 0 && pair[1] >= 0).count();
		rising as f32 / (left.len() as f32 / 48_000.0)
	}

	#[test]
	fn speed_changes_how_much_input_is_used_not_the_pitch() {
		for speed in [0.5, 1.0, 1.5, 2.0, 4.0, 10.0] {
			let (out, fed) = run(speed, 4);
			let used = fed as f64 / (4.0 * 48_000.0);
			// Within a few frames of buffering of the speed asked for.
			assert!((used - speed).abs() < 0.05 * speed.max(1.0), "speed {speed} used {used}x the input");
			let heard = pitch(&out);
			assert!((heard - 440.0).abs() < 10.0, "speed {speed} moved 440Hz to {heard}Hz");
		}
	}

	#[test]
	fn at_unity_the_output_is_the_input() {
		let (out, _) = run(1.0, 1);
		let expected = sine(440.0, 0, out.len() / 2);
		let worst = out.iter().zip(&expected).map(|(a, b)| (*a as i32 - *b as i32).abs()).max().unwrap();
		assert!(worst <= 2, "unity drifted by {worst}");
	}

	#[test]
	fn the_slowest_speed_still_produces_audio() {
		let (out, fed) = run(MIN_SPEED, 2);
		assert_eq!(out.len(), 2 * 50 * HOP * STEREO);
		assert!(fed < 48_000, "two seconds at 0.01x should need a fraction of a second, took {fed}");
		assert!(out.iter().any(|&sample| sample.abs() > 1000));
	}

	#[test]
	fn speeds_out_of_range_are_clamped() {
		assert_eq!(Stretcher::new(0.0).speed(), MIN_SPEED);
		assert_eq!(Stretcher::new(50.0).speed(), MAX_SPEED);
		assert_eq!(Stretcher::new(f64::NAN).speed(), 1.0);
	}

	#[test]
	fn the_buffer_does_not_grow_without_bound() {
		let mut stretcher = Stretcher::new(10.0);
		let mut frame = vec![0i16; HOP * STEREO];
		let mut fed = 0;
		for _ in 0..500 {
			while !stretcher.ready() {
				stretcher.push(&sine(440.0, fed, HOP));
				fed += HOP;
			}
			stretcher.next_frame(&mut frame);
		}
		assert!(stretcher.frames() < TRIM_AFTER + 12 * HOP, "kept {} frames", stretcher.frames());
	}
}
