//! Several tracks at once, each at its own level, under one master level.
//!
//! The queue's track is the *main* source, and it still comes from the
//! [`Player`](crate::player::Player) with its seams and crossfades. Anything
//! playing alongside it — a second song, an ambience bed, a clip — is a
//! *layer*, owned here. Every source has its own gain, and the master scales
//! the sum.
//!
//! The rule from `dsp` still holds: with no layers and the main track at unity,
//! the frame goes out byte-for-byte and no codec exists. The moment a layer
//! joins, every source is decoded, summed as PCM and encoded once. That is the
//! unavoidable price of two signals sharing one stream, and it is paid only
//! while they do.
//!
//! No gain is ever applied as a step. Each source remembers the gain its last
//! frame ended at and slides to the new one across the next frame, which is
//! what keeps a volume change, a layer joining and a layer leaving from
//! clicking. A layer that is removed is faded out over that one frame before it
//! is dropped.
//!
//! The sum saturates rather than limits. Two loud songs at full gain will clip,
//! and turning one of them down is the fix; a limiter would be quietly changing
//! the levels the listener asked for.

use amhra_audio::opus::{CHANNELS, SAMPLE_RATE};
use amhra_audio::{CacheReader, packet_info};

use crate::dsp::{DspError, MAX_SAMPLES, UNITY_EPSILON, encoder};

/// Layers one guild may play at once, on top of the main track.
///
/// Each costs a decode per frame on the guild's audio thread, which is cheap,
/// but the cap is what stops a stuck bot from piling up hundreds of them.
pub const MAX_LAYERS: usize = 8;

/// One Opus packet and the RTP time it covers.
#[derive(Debug, Clone, Copy)]
pub struct Frame<'a> {
	pub bytes: &'a [u8],
	pub samples: u32,
}

/// What happened to a layer, by the id it was added under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LayerEvent {
	Started(String),
	Finished(String),
	/// Ran dry mid-track; the download has not kept up. The rest of the mix
	/// carries on without it.
	Starved(String),
	/// Its audio could not be decoded, so it was dropped. A `Finished` follows.
	Failed { id: String, reason: String },
}

#[derive(Debug, thiserror::Error)]
pub enum MixerError {
	#[error("already mixing {MAX_LAYERS} layers")]
	Full,
	#[error("no layer {0}")]
	NoSuchLayer(String),
}

struct Layer {
	id: String,
	reader: CacheReader,
	gain: f32,
	/// Effective gain (own × master) the last mixed frame ended at.
	applied: f32,
	/// Built on the first frame. Opus decoding carries state from packet to
	/// packet, so each layer needs its own.
	decoder: Option<opus::Decoder>,
	started: bool,
	starving: bool,
	/// Fading out, to be dropped once silent.
	leaving: bool,
}

/// What a layer has for this frame.
enum Pull {
	/// This many interleaved samples were decoded into the scratch buffer.
	Decoded(usize),
	Starving,
	Finished,
	Failed(String),
}

impl Layer {
	fn new(id: String, reader: CacheReader, gain: f32) -> Self {
		Self {
			id,
			reader,
			gain,
			// From silence, so joining is a fade-in rather than a cut.
			applied: 0.0,
			decoder: None,
			started: false,
			starving: false,
			leaving: false,
		}
	}

	/// Decode the next frame into `pcm`, refreshing a still-downloading file
	/// when it runs out.
	///
	/// Mirrors the player's rule: running dry is only an ending when the file
	/// says it is complete.
	fn pull(&mut self, pcm: &mut [i16], events: &mut Vec<LayerEvent>) -> Pull {
		if self.reader.is_drained() {
			let grew = self.reader.refresh().unwrap_or(false);
			if !grew || self.reader.is_drained() {
				if self.reader.is_complete() {
					return Pull::Finished;
				}
				if !self.starving {
					self.starving = true;
					events.push(LayerEvent::Starved(self.id.clone()));
				}
				return Pull::Starving;
			}
		}
		self.starving = false;
		if !self.started {
			self.started = true;
			events.push(LayerEvent::Started(self.id.clone()));
		}
		let Some((bytes, _)) = self.reader.next_frame() else { return Pull::Starving };
		let decoder = match &mut self.decoder {
			Some(decoder) => decoder,
			None => match stereo_decoder() {
				Ok(decoder) => self.decoder.insert(decoder),
				Err(error) => return Pull::Failed(error.to_string()),
			},
		};
		match decoder.decode(bytes, pcm, false) {
			Ok(samples) => Pull::Decoded(samples * CHANNELS as usize),
			Err(error) => Pull::Failed(error.to_string()),
		}
	}
}

impl std::fmt::Debug for Layer {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Layer")
			.field("id", &self.id)
			.field("gain", &self.gain)
			.field("leaving", &self.leaving)
			.finish_non_exhaustive()
	}
}

pub struct Mixer {
	master: f32,
	main_gain: f32,
	/// Effective gain (main × master) the main track's last mixed frame ended
	/// at. Starts at unity because passthrough is unity.
	main_applied: f32,
	main_decoder: Option<opus::Decoder>,
	layers: Vec<Layer>,
	encoder: Option<opus::Encoder>,
	/// One source's decoded frame.
	pcm: Vec<i16>,
	/// The running sum, in float so sources can add past full scale before the
	/// one clamp at the end.
	sum: Vec<f32>,
	out: Vec<u8>,
	events: Vec<LayerEvent>,
}

impl std::fmt::Debug for Mixer {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Mixer")
			.field("master", &self.master)
			.field("main_gain", &self.main_gain)
			.field("layers", &self.layers)
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
			main_gain: 1.0,
			main_applied: 1.0,
			main_decoder: None,
			layers: Vec::new(),
			encoder: None,
			pcm: vec![0; MAX_SAMPLES],
			sum: vec![0.0; MAX_SAMPLES],
			out: vec![0; 4000],
			events: Vec::new(),
		}
	}

	pub fn master(&self) -> f32 {
		self.master
	}

	/// The overall level, applied on top of every source's own.
	pub fn set_master(&mut self, gain: f32) {
		self.master = gain.max(0.0);
	}

	pub fn main_gain(&self) -> f32 {
		self.main_gain
	}

	/// The queue track's own level, under the master.
	pub fn set_main_gain(&mut self, gain: f32) {
		self.main_gain = gain.max(0.0);
	}

	/// Start playing `reader` alongside everything else.
	///
	/// An id already in use is replaced: the new track fades in where the old
	/// one was, and the old one is not reported as finished, because from the
	/// caller's side the layer never ended.
	pub fn add_layer(
		&mut self,
		id: impl Into<String>,
		reader: CacheReader,
		gain: f32,
	) -> Result<(), MixerError> {
		let layer = Layer::new(id.into(), reader, gain.max(0.0));
		if let Some(existing) = self.layers.iter_mut().find(|existing| existing.id == layer.id) {
			*existing = layer;
			return Ok(());
		}
		if self.layers.len() >= MAX_LAYERS {
			return Err(MixerError::Full);
		}
		self.layers.push(layer);
		Ok(())
	}

	/// Fade a layer out and drop it. Its `Finished` arrives once it is silent,
	/// one frame from now.
	pub fn remove_layer(&mut self, id: &str) -> Result<(), MixerError> {
		self.layer_mut(id)?.leaving = true;
		Ok(())
	}

	pub fn set_layer_gain(&mut self, id: &str, gain: f32) -> Result<(), MixerError> {
		self.layer_mut(id)?.gain = gain.max(0.0);
		Ok(())
	}

	/// Fade every layer out.
	pub fn clear_layers(&mut self) {
		for layer in &mut self.layers {
			layer.leaving = true;
		}
	}

	/// Whether anything besides the main track is still sounding, including
	/// layers on their way out.
	pub fn has_layers(&self) -> bool {
		!self.layers.is_empty()
	}

	pub fn layer_ids(&self) -> impl Iterator<Item = &str> {
		self.layers.iter().filter(|layer| !layer.leaving).map(|layer| layer.id.as_str())
	}

	pub fn layer_gain(&self, id: &str) -> Option<f32> {
		self.layers.iter().find(|layer| layer.id == id).map(|layer| layer.gain)
	}

	/// Whether the next main frame would go out untouched.
	pub fn is_passthrough(&self) -> bool {
		self.layers.is_empty()
			&& is_unity(self.main_gain * self.master)
			&& is_unity(self.main_applied)
	}

	/// Take everything worth reporting since the last call.
	pub fn drain_events(&mut self) -> Vec<LayerEvent> {
		std::mem::take(&mut self.events)
	}

	/// Produce this tick's packet from the main track's frame, if it has one,
	/// and one frame of every layer.
	///
	/// `None` means there is nothing to send: no main frame and no layer with
	/// audio ready.
	pub fn mix<'a>(&'a mut self, main: Option<Frame<'a>>) -> Result<Option<Frame<'a>>, DspError> {
		if self.layers.is_empty() {
			let Some(main) = main else { return Ok(None) };
			if self.is_passthrough() {
				// Back on the free path: the codec state is dead weight, and
				// holding it would cost every idle guild ~50KB.
				self.main_decoder = None;
				self.encoder = None;
				return Ok(Some(main));
			}
		}

		let Self { master, main_gain, main_applied, main_decoder, layers, pcm, sum, events, .. } =
			self;
		// Interleaved samples in this frame. Set by the first source to
		// produce audio, so the main track decides the frame length whenever it
		// is playing and the RTP clock advances by what the queue says.
		let mut filled = 0;

		if let Some(main) = main {
			let target = *main_gain * *master;
			let decoder = match main_decoder {
				Some(decoder) => decoder,
				None => main_decoder.insert(stereo_decoder()?),
			};
			let decoded = decoder.decode(main.bytes, pcm, false)? * CHANNELS as usize;
			filled = decoded;
			sum[..filled].fill(0.0);
			accumulate(&mut sum[..filled], &pcm[..filled], *main_applied, target);
			*main_applied = target;
		} else {
			// Absent from this frame, so it fades back in rather than cutting
			// in when it returns.
			*main_applied = 0.0;
		}

		let mut index = 0;
		while index < layers.len() {
			let layer = &mut layers[index];
			let target = if layer.leaving { 0.0 } else { layer.gain * *master };

			match layer.pull(pcm, events) {
				Pull::Decoded(decoded) => {
					if filled == 0 {
						filled = decoded;
						sum[..filled].fill(0.0);
					}
					// A layer whose frames are longer than the main track's
					// loses the overhang. YouTube's Opus is 20ms throughout, so
					// in practice this never bites.
					let span = decoded.min(filled);
					accumulate(&mut sum[..span], &pcm[..span], layer.applied, target);
					layer.applied = target;
					// A leaving layer has now been faded to silence.
					if layer.leaving {
						let gone = layers.remove(index);
						events.push(LayerEvent::Finished(gone.id));
					} else {
						index += 1;
					}
				}
				Pull::Starving => {
					// A stalled layer re-enters with a fade, like a new one.
					layer.applied = 0.0;
					index += 1;
				}
				Pull::Finished => {
					let gone = layers.remove(index);
					events.push(LayerEvent::Finished(gone.id));
				}
				// One undecodable layer must not take the whole mix down with
				// it, so it is dropped and the rest play on.
				Pull::Failed(reason) => {
					let gone = layers.remove(index);
					events.push(LayerEvent::Failed { id: gone.id.clone(), reason });
					events.push(LayerEvent::Finished(gone.id));
				}
			}
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

	fn layer_mut(&mut self, id: &str) -> Result<&mut Layer, MixerError> {
		self.layers
			.iter_mut()
			.find(|layer| layer.id == id && !layer.leaving)
			.ok_or_else(|| MixerError::NoSuchLayer(id.to_owned()))
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
	use crate::test_support::{reader, tone_packet};

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

	fn frame(bytes: &[u8]) -> Option<Frame<'_>> {
		Some(Frame { bytes, samples: 960 })
	}

	/// Run `ticks` frames of `main` through the mixer and return the peak of
	/// the last, once the encoder has settled.
	fn settled_peak(mixer: &mut Mixer, main: Option<&[u8]>, ticks: usize) -> i32 {
		let mut listener = Listener::new();
		let mut peak = 0;
		for _ in 0..ticks {
			let out = mixer.mix(main.map(|bytes| Frame { bytes, samples: 960 })).unwrap();
			peak = listener.peak(out.expect("a frame").bytes);
		}
		peak
	}

	#[test]
	fn alone_at_unity_is_byte_for_byte_passthrough() {
		let packet = tone_packet(8_000);
		let mut mixer = Mixer::new();
		let out = mixer.mix(frame(&packet)).unwrap().unwrap();
		assert_eq!(out.bytes, packet.as_slice(), "nothing to mix must not re-encode");
		assert!(mixer.encoder.is_none(), "passthrough must not construct a codec");
		assert!(mixer.main_decoder.is_none());
	}

	#[test]
	fn main_and_master_gains_multiply() {
		// Half of double is unity, so this is still the free path.
		let packet = tone_packet(8_000);
		let mut mixer = Mixer::new();
		mixer.set_main_gain(0.5);
		mixer.set_master(2.0);
		assert!(mixer.is_passthrough());
		assert_eq!(mixer.mix(frame(&packet)).unwrap().unwrap().bytes, packet.as_slice());
	}

	#[test]
	fn the_master_turns_the_main_track_down() {
		let packet = tone_packet(16_000);
		let loud = settled_peak(&mut Mixer::new(), Some(&packet), 10);
		let mut quiet = Mixer::new();
		quiet.set_master(0.3);
		let quiet = settled_peak(&mut quiet, Some(&packet), 10);
		assert!(quiet < loud / 2, "0.3 master ({quiet}) should be well under unity ({loud})");
	}

	#[test]
	fn a_layer_plays_with_nothing_on_the_main_track() {
		let (layer, path) = reader("mixer-solo", &vec![tone_packet(8_000); 5]);
		let mut mixer = Mixer::new();
		mixer.add_layer("rain", layer, 1.0).unwrap();

		let mut frames = 0;
		while let Some(out) = mixer.mix(None).unwrap() {
			assert_eq!(out.samples, 960);
			frames += 1;
		}
		assert_eq!(frames, 5);
		assert!(!mixer.has_layers(), "a finished layer is dropped");
		assert_eq!(
			mixer.drain_events(),
			vec![LayerEvent::Started("rain".to_owned()), LayerEvent::Finished("rain".to_owned())]
		);
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn two_sources_sum_louder_than_one() {
		let main = tone_packet(6_000);
		let alone = settled_peak(&mut Mixer::new(), Some(&main), 1);

		let (layer, path) = reader("mixer-sum", &vec![tone_packet(6_000); 20]);
		let mut mixer = Mixer::new();
		mixer.add_layer("second", layer, 1.0).unwrap();
		let together = settled_peak(&mut mixer, Some(&main), 10);

		// The same tone twice, in phase, is close to twice the amplitude.
		assert!(
			together as f32 > alone as f32 * 1.5,
			"mixed ({together}) should be well above one source ({alone})"
		);
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn each_layer_follows_its_own_gain() {
		let (layer, path) = reader("mixer-own", &vec![tone_packet(16_000); 40]);
		let mut mixer = Mixer::new();
		mixer.add_layer("bed", layer, 1.0).unwrap();
		let loud = settled_peak(&mut mixer, None, 10);

		mixer.set_layer_gain("bed", 0.2).unwrap();
		assert_eq!(mixer.layer_gain("bed"), Some(0.2));
		let quiet = settled_peak(&mut mixer, None, 10);
		assert!(quiet < loud / 2, "0.2 layer gain ({quiet}) should be well under 1.0 ({loud})");
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn a_silent_main_track_leaves_the_layer_audible() {
		let main = tone_packet(16_000);
		let (layer, path) = reader("mixer-mute", &vec![tone_packet(16_000); 20]);
		let mut mixer = Mixer::new();
		mixer.set_main_gain(0.0);
		mixer.add_layer("only", layer, 1.0).unwrap();
		let peak = settled_peak(&mut mixer, Some(&main), 10);
		assert!(peak > 8_000, "the layer should still be heard, got {peak}");
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn removing_a_layer_fades_it_then_returns_to_passthrough() {
		let main = tone_packet(8_000);
		let (layer, path) = reader("mixer-remove", &vec![tone_packet(8_000); 50]);
		let mut mixer = Mixer::new();
		mixer.add_layer("gone", layer, 1.0).unwrap();
		mixer.mix(frame(&main)).unwrap();

		mixer.remove_layer("gone").unwrap();
		assert_eq!(mixer.layer_ids().count(), 0, "a leaving layer is no longer listed");
		assert!(mixer.has_layers(), "but it is still sounding for its fade");

		// The fade frame is still mixed...
		let fading = mixer.mix(frame(&main)).unwrap().unwrap();
		assert_ne!(fading.bytes, main.as_slice());
		assert!(mixer.drain_events().contains(&LayerEvent::Finished("gone".to_owned())));

		// ...and the frame after it is the main track's own bytes again.
		let after = mixer.mix(frame(&main)).unwrap().unwrap();
		assert_eq!(after.bytes, main.as_slice());
		assert!(mixer.encoder.is_none(), "the codec is released once nothing mixes");
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn a_starving_layer_does_not_stall_the_main_track() {
		let path = crate::test_support::temp_path("mixer-starve");
		let whole = crate::test_support::webm(&vec![tone_packet(8_000); 10]);
		std::fs::write(&path, &whole[..whole.len() / 2]).unwrap();
		let partial = CacheReader::open_path(&path, None).unwrap();

		let main = tone_packet(8_000);
		let mut mixer = Mixer::new();
		mixer.add_layer("slow", partial, 1.0).unwrap();
		for _ in 0..20 {
			assert!(mixer.mix(frame(&main)).unwrap().is_some(), "the main track must keep going");
		}
		assert!(mixer.has_layers(), "a stall is not an ending");
		let starved = mixer
			.drain_events()
			.into_iter()
			.filter(|event| matches!(event, LayerEvent::Starved(_)))
			.count();
		assert_eq!(starved, 1, "one stall should be reported once");

		// With nothing else to play and the layer dry, there is nothing to send.
		assert!(mixer.mix(None).unwrap().is_none());
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn reusing_an_id_replaces_the_layer() {
		let (first, first_path) = reader("mixer-reuse-a", &vec![tone_packet(8_000); 50]);
		let (second, second_path) = reader("mixer-reuse-b", &vec![tone_packet(8_000); 2]);
		let mut mixer = Mixer::new();
		mixer.add_layer("slot", first, 1.0).unwrap();
		mixer.mix(None).unwrap();
		mixer.add_layer("slot", second, 0.5).unwrap();

		assert_eq!(mixer.layer_ids().collect::<Vec<_>>(), vec!["slot"]);
		assert_eq!(mixer.layer_gain("slot"), Some(0.5));
		// The replacement is only two frames long, which proves it took over.
		assert!(mixer.mix(None).unwrap().is_some());
		assert!(mixer.mix(None).unwrap().is_some());
		assert!(mixer.mix(None).unwrap().is_none());
		std::fs::remove_file(&first_path).ok();
		std::fs::remove_file(&second_path).ok();
	}

	#[test]
	fn the_layer_count_is_capped() {
		let packets = vec![tone_packet(8_000); 2];
		let mut paths = Vec::new();
		let mut mixer = Mixer::new();
		for index in 0..MAX_LAYERS {
			let (layer, path) = reader(&format!("mixer-cap-{index}"), &packets);
			mixer.add_layer(index.to_string(), layer, 1.0).unwrap();
			paths.push(path);
		}
		let (extra, path) = reader("mixer-cap-extra", &packets);
		assert!(matches!(mixer.add_layer("extra", extra, 1.0), Err(MixerError::Full)));
		paths.push(path);
		for path in paths {
			std::fs::remove_file(&path).ok();
		}
	}

	#[test]
	fn unknown_layers_are_reported() {
		let mut mixer = Mixer::new();
		assert!(matches!(mixer.set_layer_gain("nope", 1.0), Err(MixerError::NoSuchLayer(_))));
		assert!(matches!(mixer.remove_layer("nope"), Err(MixerError::NoSuchLayer(_))));
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
		mixer.set_main_gain(-1.0);
		assert_eq!(mixer.master(), 0.0);
		assert_eq!(mixer.main_gain(), 0.0);
	}
}
