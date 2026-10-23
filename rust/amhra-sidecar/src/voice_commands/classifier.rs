//! A wake word classifier, instead of the keyword spotter.
//!
//! The spotter is a streaming speech recogniser that fires when the word
//! pieces it hears spell the name. This is a small network trained on the
//! name alone (`training/wake/classifier/`): it looks at the last 1.5s of a
//! speaker's sound, every 30ms, and says how sure it is that the name has just
//! been said. On the collected clips it heard every take of the name, through
//! simulated rooms too, and woke on none of the call chatter the spotter had
//! woken on; on voices it has not heard there is too little to say.
//!
//! `training/wake/classifier/export.py` lays a directory out:
//!
//! - `net.onnx`: 40 log-mel frames by 148 in, one logit out. It runs here
//!   through tract, in pure Rust: a second onnxruntime beside the one
//!   sherpa-onnx links would bring two copies of the same symbols.
//! - `features.json`: how those frames are made. They are made here, three
//!   new ones each 30ms rather than the whole window again, and the file is
//!   checked against how before anything loads, so the two cannot drift.
//! - `threshold.txt`: the score it wakes at, chosen on validation.
//!
//! Each speaker's stream starts as if after 1.5s of silence, which is what
//! training scored streams from, and starts so again after every wake.

use std::path::Path;
use std::sync::Arc;

use rustfft::num_complex::Complex32;
use rustfft::{Fft, FftPlanner};
use serde::Deserialize;
use tract_onnx::prelude::*;

use super::{Detection, ModelError, SAMPLE_RATE, Spotter, samples};

/// Mel bands per frame.
pub const MELS: usize = 40;
/// Frames in the window the network sees: 1.5s.
pub const FRAMES: usize = 148;
/// Samples in a frame: 25ms.
const N_FFT: usize = 400;
/// Samples between frames: 10ms.
const FRAME_HOP: usize = 160;
/// The silence a stream starts with, in samples: one window, 1.5s.
const SILENCE: usize = 24_000;
/// Frames between scores: 30ms.
const SCORE_HOP: usize = 3;
const F_MIN: f64 = 20.0;
const F_MAX: f64 = 7600.0;
const LOG_FLOOR: f32 = 1e-6;
/// Power spectrum bins per frame.
const BINS: usize = N_FFT / 2 + 1;

/// `features.json`, as `export.py` writes it.
#[derive(Debug, Deserialize)]
struct FeatureSpec {
	sample_rate: u32,
	n_fft: usize,
	frame_hop: usize,
	frames: usize,
	mels: usize,
	f_min: f64,
	f_max: f64,
	mel_scale: String,
	window: String,
	power: f64,
	log_floor: f64,
	score_hop: usize,
	keyword: String,
	after_ms: u32,
}

impl FeatureSpec {
	/// Whether these are the frames [`MelFrames`] makes, and if not, how not.
	fn check(&self) -> Result<(), String> {
		let ours = format!(
			"{SAMPLE_RATE}Hz, n_fft {N_FFT}, hop {FRAME_HOP}, {FRAMES} frames of {MELS} htk mels from {F_MIN} to \
			 {F_MAX}Hz, hann, periodic window, power 2, log floor {LOG_FLOOR:e}, scored every {SCORE_HOP} frames"
		);
		let theirs = format!(
			"{}Hz, n_fft {}, hop {}, {} frames of {} {} mels from {} to {}Hz, {} window, power {}, log floor {:e}, \
			 scored every {} frames",
			self.sample_rate,
			self.n_fft,
			self.frame_hop,
			self.frames,
			self.mels,
			self.mel_scale,
			self.f_min,
			self.f_max,
			self.window,
			self.power,
			self.log_floor as f32,
			self.score_hop,
		);
		if ours == theirs { Ok(()) } else { Err(format!("features.json asks for {theirs}; this build makes {ours}")) }
	}
}

/// The network and how it is run, loaded once and shared by every speaker.
pub struct Classifier {
	plan: Arc<TypedRunnableModel>,
	/// The probability at or above which it wakes.
	threshold: f32,
	keyword: String,
	/// How long, in samples, before the end of a window it woke on the name
	/// ended, at the middle of what it was trained on.
	after: usize,
	mel: Arc<MelFilters>,
}

fn load_error(reason: impl std::fmt::Display) -> ModelError {
	ModelError::Load { what: "the wake classifier", reason: reason.to_string() }
}

impl Classifier {
	/// Load a directory `export.py` wrote.
	pub fn load(dir: &Path) -> Result<Arc<Self>, ModelError> {
		let [net, features, threshold] = ["net.onnx", "features.json", "threshold.txt"].map(|file| dir.join(file));
		for path in [&net, &features, &threshold] {
			if !path.is_file() {
				return Err(ModelError::Missing(path.clone()));
			}
		}
		let read = |path: &Path| {
			std::fs::read_to_string(path).map_err(|error| load_error(format!("{}: {error}", path.display())))
		};
		let spec: FeatureSpec = serde_json::from_str(&read(&features)?)
			.map_err(|error| load_error(format!("{}: {error}", features.display())))?;
		spec.check().map_err(load_error)?;
		let threshold: f32 = read(&threshold)?
			.trim()
			.parse()
			.ok()
			.filter(|threshold| (0.0..=1.0).contains(threshold))
			.ok_or_else(|| load_error(format!("{} is not a probability", threshold.display())))?;

		let plan = tract_onnx::onnx()
			.model_for_path(&net)
			.and_then(|model| {
				model.with_input_fact(0, InferenceFact::dt_shape(f32::datum_type(), [1, MELS, FRAMES]))
			})
			.and_then(|model| model.into_optimized())
			.and_then(|model| model.into_runnable())
			.map_err(|error| load_error(format!("{}: {error}", net.display())))?;
		let classifier = Self {
			plan,
			threshold,
			keyword: spec.keyword,
			after: samples(spec.after_ms),
			mel: Arc::new(MelFilters::new()),
		};
		// Run once now, so a model that loads but will not run fails at
		// startup rather than on the first speaker.
		classifier.logit(&vec![LOG_FLOOR.ln(); MELS * FRAMES]).map_err(load_error)?;
		Ok(Arc::new(classifier))
	}

	/// The logit for one window, mel-major: `MELS` rows of `FRAMES`.
	fn logit(&self, window: &[f32]) -> Result<f32, String> {
		let run = || -> TractResult<TVec<TValue>> {
			let input = Tensor::from_shape(&[1, MELS, FRAMES], window)?;
			self.plan.run(tvec!(input.into()))
		};
		let output = run().map_err(|error| error.to_string())?;
		output[0].to_plain_array_view::<f32>().ok().and_then(|logit| logit.iter().next().copied()).ok_or_else(|| "no logit".to_owned())
	}

	/// A stream for one speaker.
	pub fn spotter(self: &Arc<Self>) -> ClassifierSpotter {
		ClassifierSpotter::new(Arc::clone(self))
	}
}

/// HTK mel filters over a power spectrum, as torchaudio's `melscale_fbanks`
/// makes them (no normalisation), with the hann window and the FFT plan.
struct MelFilters {
	/// Per mel, the first bin it covers and its weights from there.
	bands: Vec<(usize, Vec<f32>)>,
	window: Vec<f32>,
	fft: Arc<dyn Fft<f32>>,
}

impl MelFilters {
	fn new() -> Self {
		let hz_to_mel = |hz: f64| 2595.0 * (1.0 + hz / 700.0).log10();
		let mel_to_hz = |mel: f64| 700.0 * (10f64.powf(mel / 2595.0) - 1.0);
		let (low, high) = (hz_to_mel(F_MIN), hz_to_mel(F_MAX));
		let points: Vec<f64> =
			(0..MELS + 2).map(|i| mel_to_hz(low + (high - low) * i as f64 / (MELS + 1) as f64)).collect();
		let nyquist = f64::from(SAMPLE_RATE / 2);
		let bands = (0..MELS)
			.map(|m| {
				let weights: Vec<f32> = (0..BINS)
					.map(|bin| {
						let hz = nyquist * bin as f64 / (BINS - 1) as f64;
						let down = (hz - points[m]) / (points[m + 1] - points[m]);
						let up = (points[m + 2] - hz) / (points[m + 2] - points[m + 1]);
						down.min(up).max(0.0) as f32
					})
					.collect();
				let first = weights.iter().position(|&w| w > 0.0).unwrap_or(0);
				let last = weights.iter().rposition(|&w| w > 0.0).unwrap_or(0);
				(first, weights[first..=last.max(first)].to_vec())
			})
			.collect();
		let window = (0..N_FFT)
			.map(|n| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / N_FFT as f64).cos()) as f32)
			.collect();
		Self { bands, window, fft: FftPlanner::new().plan_fft_forward(N_FFT) }
	}
}

/// Log-mel frames from a stream of samples, one per [`FRAME_HOP`].
struct MelFrames {
	mel: Arc<MelFilters>,
	/// Samples not yet framed: the last frame's overlap and what came after.
	pending: Vec<f32>,
	spectrum: Vec<Complex32>,
	scratch: Vec<Complex32>,
	power: [f32; BINS],
}

impl MelFrames {
	fn new(mel: Arc<MelFilters>) -> Self {
		let scratch = vec![Complex32::default(); mel.fft.get_inplace_scratch_len()];
		Self { mel, pending: Vec::new(), spectrum: vec![Complex32::default(); N_FFT], scratch, power: [0.0; BINS] }
	}

	/// The next frame, if enough has been heard for one.
	fn next(&mut self, frame: &mut [f32; MELS]) -> bool {
		if self.pending.len() < N_FFT {
			return false;
		}
		for ((out, &sample), &weight) in self.spectrum.iter_mut().zip(&self.pending).zip(&self.mel.window) {
			*out = Complex32::new(sample * weight, 0.0);
		}
		self.mel.fft.process_with_scratch(&mut self.spectrum, &mut self.scratch);
		for (power, bin) in self.power.iter_mut().zip(&self.spectrum) {
			*power = bin.norm_sqr();
		}
		for (out, (first, weights)) in frame.iter_mut().zip(&self.mel.bands) {
			let energy: f32 = weights.iter().zip(&self.power[*first..]).map(|(w, p)| w * p).sum();
			*out = (energy + LOG_FLOOR).ln();
		}
		self.pending.drain(..FRAME_HOP);
		true
	}

	/// Start again, as after a window of silence: its frames are all
	/// made, and what is left of it overlaps the next.
	fn start(&mut self) {
		self.pending.clear();
		self.pending.resize(SILENCE - FRAMES * FRAME_HOP, 0.0);
	}

	/// Samples heard after the end of the last frame made.
	fn beyond_last(&self) -> usize {
		self.pending.len().saturating_sub(N_FFT - FRAME_HOP)
	}
}

/// One speaker's stream through the classifier.
pub struct ClassifierSpotter {
	classifier: Arc<Classifier>,
	frames: MelFrames,
	/// The last [`FRAMES`] frames, oldest at `head`.
	ring: Vec<[f32; MELS]>,
	head: usize,
	/// Frames made since the stream began, counting the silence it begins
	/// with.
	made: usize,
	window: Vec<f32>,
}

impl ClassifierSpotter {
	fn new(classifier: Arc<Classifier>) -> Self {
		let frames = MelFrames::new(Arc::clone(&classifier.mel));
		let mut spotter =
			Self { classifier, frames, ring: vec![[0.0; MELS]; FRAMES], head: 0, made: 0, window: vec![0.0; MELS * FRAMES] };
		spotter.reset();
		spotter
	}

	/// The probability that the window ending at the last frame ends just
	/// after the name.
	fn score(&mut self) -> f32 {
		for (t, frame) in self.ring[self.head..].iter().chain(&self.ring[..self.head]).enumerate() {
			for (m, &value) in frame.iter().enumerate() {
				self.window[m * FRAMES + t] = value;
			}
		}
		match self.classifier.logit(&self.window) {
			Ok(logit) => 1.0 / (1.0 + (-logit).exp()),
			Err(error) => {
				eprintln!("voice commands: the wake classifier failed: {error}");
				0.0
			}
		}
	}
}

impl Spotter for ClassifierSpotter {
	fn accept(&mut self, samples: &[f32]) -> Option<Detection> {
		self.frames.pending.extend_from_slice(samples);
		let mut frame = [0.0; MELS];
		while self.frames.next(&mut frame) {
			self.ring[self.head] = frame;
			self.head = (self.head + 1) % FRAMES;
			self.made += 1;
			if (self.made - FRAMES).is_multiple_of(SCORE_HOP) && self.score() >= self.classifier.threshold {
				return Some(Detection {
					keyword: self.classifier.keyword.clone(),
					lag: self.frames.beyond_last() + self.classifier.after,
				});
			}
		}
		None
	}

	/// Back to the start of a stream: a window of silence, as if the speaker
	/// had just joined.
	fn reset(&mut self) {
		self.ring.fill([LOG_FLOOR.ln(); MELS]);
		self.head = 0;
		self.made = FRAMES;
		self.frames.start();
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// What `export.py` wrote: frames and logits of a known signal.
	#[derive(Deserialize)]
	struct Check {
		frames: Vec<CheckFrame>,
		logits: Vec<CheckLogit>,
	}

	#[derive(Deserialize)]
	struct CheckFrame {
		index: usize,
		values: Vec<f32>,
	}

	#[derive(Deserialize)]
	struct CheckLogit {
		first_frame: usize,
		logit: f32,
	}

	/// `export.py`'s `check_signal`: two tones and a sweep, 3s.
	fn check_signal() -> Vec<f32> {
		(0..3 * SAMPLE_RATE as usize)
			.map(|i| {
				let t = i as f64 / f64::from(SAMPLE_RATE);
				let tau = 2.0 * std::f64::consts::PI;
				let signal = 0.2 * (tau * 440.0 * t).sin()
					+ 0.1 * (tau * 1750.0 * t).sin()
					+ 0.05 * (tau * (200.0 + 900.0 * t) * t).sin();
				// numpy rounds halves to even; a tie never lands here.
				(signal * 32767.0).round() as i16 as f32 / 32768.0
			})
			.collect()
	}

	/// The exported model, if there is one here: it is trained, not
	/// downloaded, so CI never has it.
	fn exported() -> Option<(Arc<Classifier>, Check)> {
		let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../models/voice/wake-classifier");
		let Ok(check) = std::fs::read_to_string(dir.join("check.json")) else {
			eprintln!("skipping: no classifier in {}", dir.display());
			return None;
		};
		Some((Classifier::load(&dir).unwrap(), serde_json::from_str(&check).unwrap()))
	}

	/// Frames of the check signal after a window of silence, as a stream
	/// makes them from its start.
	fn stream_frames(mel: Arc<MelFilters>) -> Vec<[f32; MELS]> {
		let mut frames = MelFrames::new(mel);
		frames.pending = vec![0.0; SILENCE];
		frames.pending.extend(check_signal());
		let mut out = Vec::new();
		let mut frame = [0.0; MELS];
		while frames.next(&mut frame) {
			out.push(frame);
		}
		out
	}

	#[test]
	fn the_filters_cover_the_band_and_nothing_else() {
		let mel = MelFilters::new();
		let hz = |bin: usize| f64::from(SAMPLE_RATE / 2) * bin as f64 / (BINS - 1) as f64;
		let (first, _) = mel.bands[0];
		let (last, weights) = mel.bands.last().unwrap();
		assert!(hz(first) > F_MIN && hz(first) < 100.0, "{}", hz(first));
		assert!(hz(last + weights.len() - 1) < F_MAX);
		// Each band rises to near one and falls back, overlapping its
		// neighbours by half.
		for (_, weights) in &mel.bands {
			let peak = weights.iter().copied().fold(0.0, f32::max);
			assert!(peak > 0.5 && peak <= 1.0, "{peak}");
		}
	}

	#[test]
	fn silence_is_the_log_floor() {
		let mut frames = MelFrames::new(Arc::new(MelFilters::new()));
		frames.pending = vec![0.0; N_FFT];
		let mut frame = [0.0; MELS];
		assert!(frames.next(&mut frame));
		assert!(frame.iter().all(|&value| value == LOG_FLOOR.ln()));
		assert!(!frames.next(&mut frame));
	}

	#[test]
	fn reset_leaves_a_stream_where_silence_would() {
		// The frames a stream makes from its start after a window of silence
		// begin at index FRAMES; a reset spotter must make the same ones.
		let mel = Arc::new(MelFilters::new());
		let expected = stream_frames(Arc::clone(&mel));
		let mut frames = MelFrames::new(mel);
		frames.start();
		frames.pending.extend(check_signal());
		let mut frame = [0.0; MELS];
		for (index, expected) in expected.iter().enumerate().skip(FRAMES).take(50) {
			assert!(frames.next(&mut frame));
			assert_eq!(&frame, expected, "frame {index}");
		}
	}

	/// The frames and the network give what PyTorch did, so a model is
	/// heard here as it was scored in training.
	///
	/// Needs `models/voice/wake-classifier` from `export.py`; skipped, not
	/// failed, without it.
	#[test]
	fn the_exported_model_agrees_with_pytorch() {
		let Some((classifier, check)) = exported() else { return };
		let frames = stream_frames(Arc::clone(&classifier.mel));
		for expected in &check.frames {
			for (m, (&ours, &theirs)) in frames[expected.index].iter().zip(&expected.values).enumerate() {
				assert!((ours - theirs).abs() < 2e-3, "frame {} mel {m}: {ours} against {theirs}", expected.index);
			}
		}
		for expected in &check.logits {
			let mut window = vec![0.0; MELS * FRAMES];
			for (t, frame) in frames[expected.first_frame..expected.first_frame + FRAMES].iter().enumerate() {
				for (m, &value) in frame.iter().enumerate() {
					window[m * FRAMES + t] = value;
				}
			}
			let logit = classifier.logit(&window).unwrap();
			assert!(
				(logit - expected.logit).abs() < 1e-3 * expected.logit.abs().max(1.0),
				"window from frame {}: {logit} against {}",
				expected.first_frame,
				expected.logit
			);
		}
	}

	#[test]
	fn tones_do_not_wake_it() {
		let Some((classifier, _)) = exported() else { return };
		let mut spotter = classifier.spotter();
		for chunk in check_signal().chunks(320) {
			assert_eq!(spotter.accept(chunk), None);
		}
	}
}
