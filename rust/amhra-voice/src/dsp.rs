//! Volume, and the decision not to apply it.
//!
//! Opus carries no gain field the receiver will honour — the container's output
//! gain lives in a header Discord never sees — so changing volume means
//! decoding to PCM, scaling, and re-encoding. That is the expensive path, and
//! the whole point of this module is to avoid it: at volume 100 the frame is
//! passed through byte-for-byte, and the codec is never even constructed.
//!
//! The old TypeScript pipeline paid the decode/encode cost on every stream
//! regardless of volume, plus an ffmpeg process per track. Here it is paid only
//! by the streams that actually asked for it.
//!
//! Switching between the two modes mid-stream is legal Opus but is a
//! discontinuity in the encoder's state, which can click. A short ramp is
//! applied across the change for that reason, not for the volume change itself.

use amhra_audio::opus::{CHANNELS, FRAME_SIZE, SAMPLE_RATE};

/// Gains within this of 1.0 are treated as untouched. A listener cannot hear
/// 0.2% and it is not worth a codec round trip.
const UNITY_EPSILON: f32 = 0.002;

/// Frames over which a mode change is ramped, at 20ms each.
const RAMP_FRAMES: u32 = 2;

/// Largest PCM buffer a single Opus packet can decode to: 120ms stereo.
const MAX_SAMPLES: usize = (SAMPLE_RATE as usize / 1000) * 120 * CHANNELS as usize;

#[derive(Debug, thiserror::Error)]
pub enum DspError {
	#[error("opus: {0}")]
	Opus(#[from] opus::Error),
}

/// Applies gain to Opus frames, or gets out of the way.
pub struct Volume {
	gain: f32,
	codec: Option<Codec>,
	pcm: Vec<i16>,
	encoded: Vec<u8>,
	/// Frames left in the ramp that follows a mode change.
	ramp: u32,
	/// Gain the current ramp started from.
	ramp_from: f32,
}

struct Codec {
	decoder: opus::Decoder,
	encoder: opus::Encoder,
}

impl std::fmt::Debug for Volume {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Volume")
			.field("gain", &self.gain)
			.field("passthrough", &self.is_passthrough())
			.finish_non_exhaustive()
	}
}

impl Default for Volume {
	fn default() -> Self {
		Self::new()
	}
}

impl Volume {
	pub fn new() -> Self {
		Self {
			gain: 1.0,
			codec: None,
			pcm: vec![0; MAX_SAMPLES],
			encoded: vec![0; 4000],
			ramp: 0,
			ramp_from: 1.0,
		}
	}

	pub fn gain(&self) -> f32 {
		self.gain
	}

	/// Whether frames are currently passing through untouched.
	pub fn is_passthrough(&self) -> bool {
		(self.gain - 1.0).abs() < UNITY_EPSILON
	}

	/// Set the linear gain. 1.0 restores passthrough.
	///
	/// Takes effect on the next frame, so a volume command is audible within
	/// 20ms rather than after whatever is buffered downstream.
	pub fn set_gain(&mut self, gain: f32) {
		let gain = gain.max(0.0);
		let previous = self.gain;
		let was_passthrough = self.is_passthrough();
		self.gain = gain;
		if was_passthrough != self.is_passthrough() {
			self.ramp = RAMP_FRAMES;
			self.ramp_from = previous;
		}
		// Dropping the codec when it is not needed returns its state; keeping
		// it would hold ~30KB per idle stream for nothing.
		if self.is_passthrough() && self.ramp == 0 {
			self.codec = None;
		}
	}

	/// Process one Opus packet.
	///
	/// Returns the input slice itself when nothing needs doing, so the common
	/// case costs one comparison and no copy.
	pub fn process<'a>(&'a mut self, frame: &'a [u8]) -> Result<&'a [u8], DspError> {
		if self.is_passthrough() && self.ramp == 0 {
			return Ok(frame);
		}

		if self.codec.is_none() {
			let decoder = opus::Decoder::new(SAMPLE_RATE, opus::Channels::Stereo)?;
			let mut encoder =
				opus::Encoder::new(SAMPLE_RATE, opus::Channels::Stereo, opus::Application::Audio)?;
			// Match what YouTube's Opus is already encoded at, so a volume
			// change is not also a quality change.
			encoder.set_bitrate(opus::Bitrate::Bits(128_000))?;
			self.codec = Some(Codec { decoder, encoder });
		}

		// Where the gain sits at the start and end of this frame. Outside a
		// ramp both are the target, so the loop below is a plain multiply.
		let (from, to) = self.ramp_bounds();

		// Split the borrows: the codec, the PCM scratch and the output buffer
		// are three fields, and the encoder needs two of them at once.
		let Self { codec, pcm, encoded, .. } = self;
		let codec = codec.as_mut().expect("constructed above");

		let samples = codec.decoder.decode(frame, pcm, false)?;
		let filled = samples * CHANNELS as usize;

		apply_gain(&mut pcm[..filled], from, to);

		let written = codec.encoder.encode(&pcm[..filled], encoded)?;

		self.ramp = self.ramp.saturating_sub(1);
		// Once back at unity with the ramp spent, the codec is dead weight:
		// releasing it returns ~30KB per stream that is no longer scaling.
		if self.ramp == 0 && self.is_passthrough() {
			self.codec = None;
		}
		Ok(&self.encoded[..written])
	}

	/// Gain at the start and end of the frame about to be processed.
	fn ramp_bounds(&self) -> (f32, f32) {
		if self.ramp == 0 {
			return (self.gain, self.gain);
		}
		let steps = RAMP_FRAMES as f32;
		let done = (RAMP_FRAMES - self.ramp) as f32;
		let at = |position: f32| self.ramp_from + (self.gain - self.ramp_from) * (position / steps);
		(at(done), at(done + 1.0))
	}
}

/// Scale a block of PCM, sliding the gain from `from` to `to` across it.
///
/// Pulled out because this is the part with an exact right answer: a lossy
/// codec round trip does not preserve amplitudes closely enough to assert on,
/// but this does.
fn apply_gain(pcm: &mut [i16], from: f32, to: f32) {
	let span = pcm.len().max(1) as f32;
	for (index, sample) in pcm.iter_mut().enumerate() {
		let gain = from + (to - from) * (index as f32 / span);
		// Saturating rather than wrapping: a wrap turns a loud passage into
		// white noise, which is the worst way for a volume control to fail.
		*sample = (*sample as f32 * gain).clamp(i16::MIN as f32, i16::MAX as f32) as i16;
	}
}

/// Samples per channel in a standard frame, re-exported for callers sizing
/// buffers.
pub const STANDARD_FRAME: u32 = FRAME_SIZE;

#[cfg(test)]
mod tests {
	use super::*;

	/// A real Opus packet, made by encoding a tone.
	fn tone_packet(amplitude: i16) -> Vec<u8> {
		let mut encoder =
			opus::Encoder::new(SAMPLE_RATE, opus::Channels::Stereo, opus::Application::Audio)
				.unwrap();
		let mut pcm = vec![0i16; FRAME_SIZE as usize * CHANNELS as usize];
		for (index, sample) in pcm.iter_mut().enumerate() {
			let phase = (index / CHANNELS as usize) as f32 / SAMPLE_RATE as f32;
			*sample = ((phase * 440.0 * std::f32::consts::TAU).sin() * amplitude as f32) as i16;
		}
		let mut out = vec![0u8; 4000];
		let written = encoder.encode(&pcm, &mut out).unwrap();
		out.truncate(written);
		out
	}

	fn decode_peak(packet: &[u8]) -> i32 {
		let mut decoder = opus::Decoder::new(SAMPLE_RATE, opus::Channels::Stereo).unwrap();
		let mut pcm = vec![0i16; MAX_SAMPLES];
		let samples = decoder.decode(packet, &mut pcm, false).unwrap();
		pcm[..samples * CHANNELS as usize].iter().map(|s| (*s as i32).abs()).max().unwrap_or(0)
	}

	#[test]
	fn unity_gain_is_byte_for_byte_passthrough() {
		let packet = tone_packet(8_000);
		let mut volume = Volume::new();
		assert!(volume.is_passthrough());

		let out = volume.process(&packet).unwrap();
		assert_eq!(out, packet.as_slice(), "unity gain must not re-encode");
		// And no codec was ever built.
		assert!(volume.codec.is_none(), "passthrough must not construct a codec");
	}

	#[test]
	fn near_unity_gains_still_pass_through() {
		let packet = tone_packet(8_000);
		let mut volume = Volume::new();
		volume.set_gain(1.001);
		assert_eq!(volume.process(&packet).unwrap(), packet.as_slice());
	}

	#[test]
	fn gain_scales_samples_exactly() {
		let mut pcm = vec![1000i16; 8];
		apply_gain(&mut pcm, 0.5, 0.5);
		assert!(pcm.iter().all(|sample| *sample == 500));

		let mut pcm = vec![-1000i16; 8];
		apply_gain(&mut pcm, 2.0, 2.0);
		assert!(pcm.iter().all(|sample| *sample == -2000));

		let mut pcm = vec![1234i16; 4];
		apply_gain(&mut pcm, 0.0, 0.0);
		assert!(pcm.iter().all(|sample| *sample == 0));
	}

	#[test]
	fn gain_slides_smoothly_across_a_ramp() {
		let mut pcm = vec![1000i16; 4];
		apply_gain(&mut pcm, 0.0, 1.0);
		// Monotonically rising, starting at silence, never overshooting.
		assert_eq!(pcm[0], 0);
		assert!(pcm.windows(2).all(|pair| pair[1] > pair[0]));
		assert!(pcm.iter().all(|sample| *sample <= 1000));
	}

	#[test]
	fn clipping_saturates_rather_than_wrapping() {
		// The failure this guards against turns the loudest passage into noise.
		let mut pcm = vec![30_000i16, -30_000, 20_000, -20_000];
		apply_gain(&mut pcm, 4.0, 4.0);
		assert_eq!(pcm, vec![i16::MAX, i16::MIN, i16::MAX, i16::MIN]);
	}

	#[test]
	fn scaling_down_makes_the_stream_quieter_end_to_end() {
		// Through a real codec the exact ratio is not stable, but the direction
		// is: the same source at half gain must come out quieter.
		let packet = tone_packet(16_000);
		let peak_at = |gain: f32| {
			let mut volume = Volume::new();
			volume.set_gain(gain);
			// Let the encoder reach steady state before measuring.
			let mut peak = 0;
			for _ in 0..10 {
				peak = decode_peak(volume.process(&packet).unwrap());
			}
			peak
		};
		let loud = peak_at(0.99);
		let quiet = peak_at(0.3);
		assert!(quiet < loud, "0.3 gain ({quiet}) should be quieter than 0.99 ({loud})");
	}

	#[test]
	fn zero_gain_produces_effectively_silence() {
		let packet = tone_packet(16_000);
		let mut volume = Volume::new();
		volume.set_gain(0.0);
		let mut peak = i32::MAX;
		for _ in 0..10 {
			peak = decode_peak(volume.process(&packet).unwrap());
		}
		// Not exactly zero: the encoder emits its own low-level noise floor.
		assert!(peak < 200, "expected near-silence, got a peak of {peak}");
	}

	#[test]
	fn negative_gains_are_treated_as_silence() {
		let mut volume = Volume::new();
		volume.set_gain(-2.0);
		assert_eq!(volume.gain(), 0.0);
	}
}
