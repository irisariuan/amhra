//! Several queues at once, each at its own level, under one master level.
//!
//! Every queue is a [`Player`](crate::player::Player) of its own, with its
//! seams, crossfades and seeking; the mixer never reads a track itself. Each
//! tick it is handed the frame of every queue that has one, by queue id, and
//! sums them. Every queue has its own gain, and the master scales the sum.
//!
//! The rule from `dsp` still holds: with one queue sounding and it at unity,
//! the frame goes out byte-for-byte and no codec exists. The moment a second
//! queue sounds, every frame is decoded, summed as PCM and encoded once. That
//! is the unavoidable price of two signals sharing one stream, and it is paid
//! only while they do.
//!
//! No gain is ever applied as a step. Each queue remembers the gain its last
//! frame ended at and slides to the new one across the next frame, which is
//! what keeps a volume change, a queue joining and a queue leaving from
//! clicking. A queue that drops out while others play comes back in with a
//! fade, and one being removed is faded to silence over its last frame.
//!
//! The sum saturates rather than limits. Two loud songs at full gain will clip,
//! and turning one of them down is the fix; a limiter would be quietly changing
//! the levels the listener asked for.

use amhra_audio::opus::{CHANNELS, SAMPLE_RATE};
use amhra_audio::packet_info;

use crate::dsp::{DspError, MAX_SAMPLES, UNITY_EPSILON, encoder};

/// Queues one guild may play at once.
///
/// Each costs a decode per frame on the guild's audio thread while others are
/// sounding, which is cheap, but the cap is what stops a stuck bot from piling
/// up hundreds of them.
pub const MAX_QUEUES: usize = 9;

/// One Opus packet and the RTP time it covers.
#[derive(Debug, Clone, Copy)]
pub struct Frame<'a> {
	pub bytes: &'a [u8],
	pub samples: u32,
}

/// A queue's place in the mix: its level, and the decoder its frames need
/// once they are summed with another's.
struct Source {
	id: String,
	gain: f32,
	/// Effective gain (own × master) the last mixed frame ended at. Starts at
	/// unity, because a queue that starts alone is passed through untouched.
	applied: f32,
	/// Built on the first mixed frame. Opus decoding carries state from packet
	/// to packet, so each queue needs its own.
	decoder: Option<opus::Decoder>,
}

impl std::fmt::Debug for Source {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Source").field("id", &self.id).field("gain", &self.gain).finish_non_exhaustive()
	}
}

impl Source {
	fn new(id: &str) -> Self {
		Self { id: id.to_owned(), gain: 1.0, applied: 1.0, decoder: None }
	}
}

pub struct Mixer {
	master: f32,
	sources: Vec<Source>,
	encoder: Option<opus::Encoder>,
	/// One source's decoded frame.
	pcm: Vec<i16>,
	/// The running sum, in float so sources can add past full scale before the
	/// one clamp at the end.
	sum: Vec<f32>,
	out: Vec<u8>,
	/// Queues whose frame could not be decoded, with why, since the last
	/// `drain_failures`.
	failures: Vec<(String, String)>,
}

impl std::fmt::Debug for Mixer {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Mixer")
			.field("master", &self.master)
			.field("sources", &self.sources)
			.finish_non_exhaustive()
	}
}

impl Default for Mixer {
	fn default() -> Self {
		Self::new()
	}
}

impl Mixer {
	pub fn new() -> Self {
		Self {
			master: 1.0,
			sources: Vec::new(),
			encoder: None,
			pcm: vec![0; MAX_SAMPLES],
			sum: vec![0.0; MAX_SAMPLES],
			out: vec![0; 4000],
			failures: Vec::new(),
		}
	}

	pub fn master(&self) -> f32 {
		self.master
	}

	/// The overall level, applied on top of every queue's own.
	pub fn set_master(&mut self, gain: f32) {
		self.master = gain.max(0.0);
	}

	/// A queue's own level, under the master. Unity for one never set.
	pub fn gain(&self, id: &str) -> f32 {
		self.sources.iter().find(|source| source.id == id).map_or(1.0, |source| source.gain)
	}

	pub fn set_gain(&mut self, id: &str, gain: f32) {
		self.source_mut(id).gain = gain.max(0.0);
	}

	/// Forget a queue: its level and its decoder.
	pub fn remove(&mut self, id: &str) {
		self.sources.retain(|source| source.id != id);
	}

	/// Whether this frame from `id`, sounding alone, would go out untouched.
	pub fn is_passthrough(&self, id: &str) -> bool {
		let Some(source) = self.sources.iter().find(|source| source.id == id) else {
			return is_unity(self.master);
		};
		is_unity(source.gain * self.master) && is_unity(source.applied)
	}

	/// Queues whose frame could not be decoded since the last call, with why.
	/// Their frames were left out of the mix.
	pub fn drain_failures(&mut self) -> Vec<(String, String)> {
		std::mem::take(&mut self.failures)
	}

	/// Produce this tick's packet from the frame of every queue that has one,
	/// in order: the first decides the frame's length.
	///
	/// `None` means there is nothing to send.
	pub fn mix<'a>(&'a mut self, frames: &[(&str, Frame<'a>)]) -> Result<Option<Frame<'a>>, DspError> {
		if let [(id, frame)] = frames
			&& self.is_passthrough(id)
		{
			// Back on the free path: the codec state is dead weight, and
			// holding it would cost every idle guild ~50KB per queue. The
			// others are silent, so they fade in when they next sound.
			for source in &mut self.sources {
				source.decoder = None;
				if source.id != *id {
					source.applied = 0.0;
				}
			}
			self.encoder = None;
			return Ok(Some(*frame));
		}
		if frames.is_empty() {
			return Ok(None);
		}

		// Every queue sounding gets a place, so it carries its ramp from here.
		for (id, _) in frames {
			self.source_mut(id);
		}
		let Self { master, sources, pcm, sum, failures, .. } = self;
		// Interleaved samples in this frame. Set by the first queue to produce
		// audio, so the RTP clock advances by what that queue says.
		let mut filled = 0;

		for source in sources.iter_mut() {
			let Some((_, frame)) = frames.iter().find(|(id, _)| *id == source.id) else {
				// Absent from this frame, so it fades back in rather than
				// cutting in when it returns.
				source.applied = 0.0;
				continue;
			};
			let decoder = match &mut source.decoder {
				Some(decoder) => decoder,
				None => source.decoder.insert(stereo_decoder()?),
			};
			let decoded = match decoder.decode(frame.bytes, pcm, false) {
				Ok(samples) => samples * CHANNELS as usize,
				// One undecodable queue must not take the whole mix down with
				// it: its frame is left out, and the worker is told.
				Err(error) => {
					failures.push((source.id.clone(), error.to_string()));
					continue;
				}
			};
			if filled == 0 {
				filled = decoded;
				sum[..filled].fill(0.0);
			}
			// A queue whose frames are longer than the first's loses the
			// overhang. YouTube's Opus is 20ms throughout, so in practice this
			// never bites.
			let span = decoded.min(filled);
			let target = source.gain * *master;
			accumulate(&mut sum[..span], &pcm[..span], source.applied, target);
			source.applied = target;
		}

		if filled == 0 {
			return Ok(None);
		}

		for (sample, mixed) in pcm[..filled].iter_mut().zip(&sum[..filled]) {
			// Saturating rather than wrapping: a wrap turns a loud passage into
			// white noise.
			*sample = mixed.clamp(i16::MIN as f32, i16::MAX as f32) as i16;
		}
		let encoder = match &mut self.encoder {
			Some(encoder) => encoder,
			None => self.encoder.insert(encoder()?),
		};
		let written = encoder.encode(&self.pcm[..filled], &mut self.out)?;
		let bytes = &self.out[..written];
		let samples = packet_info(bytes).map_or((filled / CHANNELS as usize) as u32, |info| {
			info.samples()
		});
		Ok(Some(Frame { bytes, samples }))
	}

	fn source_mut(&mut self, id: &str) -> &mut Source {
		let index = match self.sources.iter().position(|source| source.id == id) {
			Some(index) => index,
			None => {
				self.sources.push(Source::new(id));
				self.sources.len() - 1
			}
		};
		&mut self.sources[index]
	}
}

fn is_unity(gain: f32) -> bool {
	(gain - 1.0).abs() < UNITY_EPSILON
}

fn stereo_decoder() -> Result<opus::Decoder, DspError> {
	Ok(opus::Decoder::new(SAMPLE_RATE, opus::Channels::Stereo)?)
}

/// Add a block of PCM into the sum, sliding its gain from `from` to `to`.
///
/// The constant-gain case is split out for the same reason as in `dsp`: it is
/// all but one frame of any level, and without the per-sample interpolation the
/// loop vectorises.
fn accumulate(sum: &mut [f32], pcm: &[i16], from: f32, to: f32) {
	if from == to {
		for (total, sample) in sum.iter_mut().zip(pcm) {
			*total += *sample as f32 * from;
		}
		return;
	}
	let step = (to - from) / sum.len().max(1) as f32;
	for (index, (total, sample)) in sum.iter_mut().zip(pcm).enumerate() {
		*total += *sample as f32 * (from + step * index as f32);
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::test_support::tone_packet;

	/// Peak of each frame of a stream, decoded the way a listener would: one
	/// decoder carried across every packet.
	struct Listener(opus::Decoder, Vec<i16>);

	impl Listener {
		fn new() -> Self {
			Self(stereo_decoder().unwrap(), vec![0; MAX_SAMPLES])
		}

		fn peak(&mut self, packet: &[u8]) -> i32 {
			let samples = self.0.decode(packet, &mut self.1, false).unwrap();
			self.1[..samples * CHANNELS as usize].iter().map(|s| (*s as i32).abs()).max().unwrap_or(0)
		}
	}

	fn frame(bytes: &[u8]) -> Frame<'_> {
		Frame { bytes, samples: 960 }
	}

	/// Run `ticks` frames of the given queues through the mixer and return the
	/// peak of the last, once the encoder has settled.
	fn settled_peak(mixer: &mut Mixer, queues: &[(&str, &[u8])], ticks: usize) -> i32 {
		let mut listener = Listener::new();
		let mut peak = 0;
		for _ in 0..ticks {
			let frames: Vec<_> = queues.iter().map(|(id, bytes)| (*id, frame(bytes))).collect();
			let out = mixer.mix(&frames).unwrap();
			peak = listener.peak(out.expect("a frame").bytes);
		}
		peak
	}

	#[test]
	fn alone_at_unity_is_byte_for_byte_passthrough() {
		let packet = tone_packet(8_000);
		let mut mixer = Mixer::new();
		let out = mixer.mix(&[("1", frame(&packet))]).unwrap().unwrap();
		assert_eq!(out.bytes, packet.as_slice(), "nothing to mix must not re-encode");
		assert!(mixer.encoder.is_none(), "passthrough must not construct a codec");
	}

	#[test]
	fn any_queue_alone_is_passed_through() {
		// No queue is special: the second alone is as free as the first.
		let packet = tone_packet(8_000);
		let mut mixer = Mixer::new();
		assert_eq!(mixer.mix(&[("2", frame(&packet))]).unwrap().unwrap().bytes, packet.as_slice());
	}

	#[test]
	fn nothing_sounding_sends_nothing() {
		assert!(Mixer::new().mix(&[]).unwrap().is_none());
	}

	#[test]
	fn own_and_master_gains_multiply() {
		// Half of double is unity, so this is still the free path.
		let packet = tone_packet(8_000);
		let mut mixer = Mixer::new();
		mixer.set_gain("1", 0.5);
		mixer.set_master(2.0);
		assert!(mixer.is_passthrough("1"));
		assert_eq!(mixer.mix(&[("1", frame(&packet))]).unwrap().unwrap().bytes, packet.as_slice());
	}

	#[test]
	fn the_master_turns_a_queue_down() {
		let packet = tone_packet(16_000);
		let loud = settled_peak(&mut Mixer::new(), &[("1", &packet)], 10);
		let mut quiet = Mixer::new();
		quiet.set_master(0.3);
		let quiet = settled_peak(&mut quiet, &[("1", &packet)], 10);
		assert!(quiet < loud / 2, "0.3 master ({quiet}) should be well under unity ({loud})");
	}

	#[test]
	fn two_queues_sum_louder_than_one() {
		let tone = tone_packet(6_000);
		let alone = settled_peak(&mut Mixer::new(), &[("1", &tone)], 1);
		let together = settled_peak(&mut Mixer::new(), &[("1", &tone), ("2", &tone)], 10);
		// The same tone twice, in phase, is close to twice the amplitude.
		assert!(
			together as f32 > alone as f32 * 1.5,
			"mixed ({together}) should be well above one queue ({alone})"
		);
	}

	#[test]
	fn each_queue_follows_its_own_gain() {
		let tone = tone_packet(16_000);
		let mut mixer = Mixer::new();
		let loud = settled_peak(&mut mixer, &[("1", &tone), ("2", &tone)], 10);
		mixer.set_gain("2", 0.0);
		assert_eq!(mixer.gain("2"), 0.0);
		let one = settled_peak(&mut mixer, &[("1", &tone), ("2", &tone)], 10);
		assert!(one < loud * 3 / 4, "with one muted ({one}) it should drop from both ({loud})");
		assert!(one > 8_000, "and the other should still be heard, got {one}");
	}

	#[test]
	fn a_queue_that_stops_mixing_returns_to_passthrough() {
		let tone = tone_packet(8_000);
		let mut mixer = Mixer::new();
		mixer.mix(&[("1", frame(&tone)), ("2", frame(&tone))]).unwrap();
		assert!(mixer.encoder.is_some());

		// "2" goes quiet: "1" alone at unity is its own bytes again.
		let after = mixer.mix(&[("1", frame(&tone))]).unwrap().unwrap();
		assert_eq!(after.bytes, tone.as_slice());
		assert!(mixer.encoder.is_none(), "the codec is released once nothing mixes");
	}

	#[test]
	fn a_queue_returning_while_another_plays_fades_back_in() {
		let tone = tone_packet(8_000);
		let mut mixer = Mixer::new();
		mixer.mix(&[("1", frame(&tone)), ("2", frame(&tone))]).unwrap();
		// "2" sits out a mixed frame...
		mixer.mix(&[("1", frame(&tone)), ("3", frame(&tone))]).unwrap();
		// ...so it comes back from silence, not at full level.
		let source = mixer.sources.iter().find(|source| source.id == "2").unwrap();
		assert_eq!(source.applied, 0.0);
		assert!(!mixer.is_passthrough("2"));
	}

	#[test]
	fn an_undecodable_frame_is_left_out_and_reported() {
		let tone = tone_packet(8_000);
		let garbage = [0xff_u8; 3];
		let mut mixer = Mixer::new();
		let out = mixer.mix(&[("1", frame(&tone)), ("2", frame(&garbage))]).unwrap();
		assert!(out.is_some(), "the good queue still plays");
		let failures = mixer.drain_failures();
		assert_eq!(failures.len(), 1);
		assert_eq!(failures[0].0, "2");
	}

	#[test]
	fn removing_a_queue_forgets_its_level() {
		let mut mixer = Mixer::new();
		mixer.set_gain("2", 0.3);
		mixer.remove("2");
		assert_eq!(mixer.gain("2"), 1.0);
	}

	#[test]
	fn accumulate_adds_exactly() {
		let mut sum = vec![100.0f32; 4];
		accumulate(&mut sum, &[1000, -1000, 1000, -1000], 0.5, 0.5);
		assert_eq!(sum, vec![600.0, -400.0, 600.0, -400.0]);

		// A ramp starts at its first gain and rises without overshooting.
		let mut sum = vec![0.0f32; 4];
		accumulate(&mut sum, &[1000; 4], 0.0, 1.0);
		assert_eq!(sum[0], 0.0);
		assert!(sum.windows(2).all(|pair| pair[1] > pair[0]));
		assert!(sum.iter().all(|total| *total <= 1000.0));
	}

	#[test]
	fn negative_gains_are_treated_as_silence() {
		let mut mixer = Mixer::new();
		mixer.set_master(-1.0);
		mixer.set_gain("1", -1.0);
		assert_eq!(mixer.master(), 0.0);
		assert_eq!(mixer.gain("1"), 0.0);
	}
}
