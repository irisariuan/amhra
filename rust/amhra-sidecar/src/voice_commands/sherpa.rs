//! The real models, through sherpa-onnx.
//!
//! - **Wake word:** a 3.3M-parameter streaming zipformer keyword spotter
//!   (GigaSpeech). One spotter for the process, one stream per speaker.
//! - **End of speech:** Silero VAD, one small instance per speaker.
//! - **Speech to text:** Qwen3-ASR 0.6B, int8, by default; or SenseVoice-Small
//!   (FunASR), int8, a quarter of its size (see [`Recogniser`]). Either way
//!   with the language worked out per window.
//!
//! The keyword spotter and the VAD go through the `sherpa-onnx` crate's safe
//! API. The recogniser does not: that wrapper parses the result JSON into a
//! struct without the detected language, and the language is half of what is
//! wanted from it; nor can it set a stream's options, which is how Qwen3-ASR
//! is pinned to a language. So [`OfflineRecogniser`] calls the C API directly
//! — a recogniser, a stream per window, and the JSON read here.
//!
//! Lay the models out with `scripts/download-voice-models.sh`; [`ModelPaths`]
//! names what it fetches.
//!
//! With [`SherpaConfig::classifier`], the wake word classifier in
//! `classifier.rs` hears the name instead of the keyword spotter, which is
//! then not loaded at all.

use std::ffi::{CStr, CString, c_char};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sherpa_onnx::{
	KeywordSpotter, KeywordSpotterConfig, OnlineStream, SileroVadModelConfig, VadModelConfig,
	VoiceActivityDetector,
};
use sherpa_onnx_sys as sys;

use super::classifier::Classifier;
use super::keywords::{self, Vocabulary};
use super::{Detection, ModelError, Models, SAMPLE_RATE, Spotter, Transcriber, Transcript, Vad};

const KWS_DIR: &str = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
const KWS_STEM: &str = "epoch-12-avg-2-chunk-16-left-64.int8.onnx";
const STT_DIR: &str = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17";
const QWEN3_DIR: &str = "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25";
const VAD_FILE: &str = "silero_vad.onnx";

/// Tunables, with the values the defaults were measured at.
#[derive(Debug, Clone)]
pub struct SherpaConfig {
	/// Where `scripts/download-voice-models.sh` put the models.
	pub models: PathBuf,
	/// The wake words, as phrases (see `keywords.rs`).
	pub keywords: String,
	/// How strongly the spotter is pulled towards a keyword, where its line
	/// does not say.
	pub keyword_boost: f32,
	/// How sure the spotter must be, where its line does not say.
	pub keyword_threshold: f32,
	/// Silero's speech probability threshold.
	pub vad_threshold: f32,
	/// Which speech recogniser.
	pub recogniser: Recogniser,
	/// Threads for the recogniser. More shortens each command; there is only
	/// ever one being recognised at a time. Measured on an M5 Pro per command:
	/// 294ms on one thread, 153ms on two, 83ms on four. Two leaves the cores
	/// to the audio threads, which must not miss a 20ms tick.
	pub recogniser_threads: i32,
	/// Where the recogniser runs.
	pub recogniser_provider: Provider,
	/// Where the keyword spotter runs. It takes 20ms at a time from every
	/// speaker, the worst case for handing work to another device, so the
	/// CPU is the default. The VAD, for the same reason, is always there, and
	/// so is the classifier, which tract runs.
	pub spotter_provider: Provider,
	/// The language the recogniser listens for: `auto`, or one of
	/// [`LANGUAGES`]. Pinned, it stops short windows being taken for another
	/// language: four of seven live takes of the name, said in English, came
	/// back as Chinese from SenseVoice on `auto` ("什么号啊？"), and as English
	/// pinned ("I Har.").
	///
	/// It is the recogniser's, not each window's. Qwen3-ASR takes it per
	/// stream, so it could be per guild; SenseVoice ignores the per-stream
	/// option, so for it that would take a recogniser per language.
	pub recogniser_language: String,
	/// A fine-tuned keyword spotter to use instead of the stock one: a
	/// directory laid out by `training/wake/export.sh`.
	pub spotter: Option<PathBuf>,
	/// A wake word classifier to hear the name with instead of any keyword
	/// spotter: a directory laid out by `training/wake/classifier/export.py`.
	/// The keywords, their boost and threshold, and `spotter` are then unused.
	pub classifier: Option<PathBuf>,
}

impl SherpaConfig {
	pub fn new(models: PathBuf, keywords: String) -> Self {
		Self {
			models,
			keywords,
			keyword_boost: 1.5,
			keyword_threshold: 0.25,
			vad_threshold: 0.5,
			recogniser: Recogniser::default(),
			recogniser_threads: 2,
			recogniser_provider: Provider::Cpu,
			spotter_provider: Provider::Cpu,
			recogniser_language: "auto".to_owned(),
			spotter: None,
			classifier: None,
		}
	}
}

/// The languages the recogniser can be pinned to.
pub const LANGUAGES: [&str; 5] = ["en", "zh", "ja", "ko", "yue"];

/// The speech-to-text model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Recogniser {
	/// Qwen3-ASR 0.6B (Alibaba's Qwen team), int8: an audio encoder and a
	/// small language model that writes out what it heard. Thirty languages
	/// and many Chinese dialects, but about 1GB, and as an autoregressive
	/// decoder it takes longer the more was said.
	#[default]
	Qwen3,
	/// SenseVoice-Small (FunASR), int8: a non-autoregressive model of about
	/// 230MB in five languages, for machines Qwen3-ASR is too big for.
	SenseVoice,
}

impl Recogniser {
	pub fn parse(name: &str) -> Option<Self> {
		match name.to_ascii_lowercase().as_str() {
			"qwen3" | "qwen3-asr" => Some(Self::Qwen3),
			"sensevoice" | "sense-voice" => Some(Self::SenseVoice),
			_ => None,
		}
	}

	/// As the settings and flags name it.
	pub fn name(self) -> &'static str {
		match self {
			Self::Qwen3 => "qwen3",
			Self::SenseVoice => "sensevoice",
		}
	}
}

/// Where onnxruntime runs a model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Provider {
	#[default]
	Cpu,
	/// Apple's Core ML, which picks among the CPU, the GPU and the Neural
	/// Engine. Measured on the int8 SenseVoice over 15 real commands, it
	/// averaged 52ms against 41ms for two CPU threads of the same build: most
	/// of a quantised model's operations are not ones Core ML runs, so it
	/// keeps handing them back.
	CoreMl,
	/// An NVIDIA GPU, through CUDA. sherpa-onnx's prebuilt libraries have no
	/// CUDA in them, so it takes a build linked against one of its GPU
	/// releases (see the `cuda-onnxruntime` feature).
	Gpu,
}

impl Provider {
	pub fn parse(name: &str) -> Option<Self> {
		match name.to_ascii_lowercase().as_str() {
			"cpu" => Some(Self::Cpu),
			"coreml" => Some(Self::CoreMl),
			"gpu" | "cuda" => Some(Self::Gpu),
			_ => None,
		}
	}

	/// As the settings and flags name it.
	pub fn name(self) -> &'static str {
		match self {
			Self::Cpu => "cpu",
			Self::CoreMl => "coreml",
			Self::Gpu => "gpu",
		}
	}

	/// As sherpa-onnx names it.
	pub fn onnx(self) -> &'static str {
		match self {
			Self::Cpu => "cpu",
			Self::CoreMl => "coreml",
			Self::Gpu => "cuda",
		}
	}

	/// Whether this build can run it. The static onnxruntime that is linked
	/// by default has neither Core ML nor CUDA in it, and sherpa-onnx would
	/// quietly fall back to the CPU rather than say so.
	pub fn available(self) -> bool {
		match self {
			Self::Cpu => true,
			Self::CoreMl => cfg!(all(feature = "shared-onnxruntime", target_os = "macos")),
			Self::Gpu => cfg!(all(feature = "cuda-onnxruntime", not(target_os = "macos"))),
		}
	}

	/// What a build needs to run it, for saying why it is not there.
	pub fn needs(self) -> &'static str {
		match self {
			Self::Cpu => "nothing",
			Self::CoreMl => "--features shared-onnxruntime, on macOS",
			Self::Gpu => {
				"--features cuda-onnxruntime and SHERPA_ONNX_LIB_DIR at a sherpa-onnx GPU release, on Linux or Windows"
			}
		}
	}
}

/// The files under the models directory.
#[derive(Debug, Clone)]
pub struct ModelPaths {
	pub kws_encoder: PathBuf,
	pub kws_decoder: PathBuf,
	pub kws_joiner: PathBuf,
	pub kws_tokens: PathBuf,
	pub kws_bpe: PathBuf,
	pub vad: PathBuf,
	pub stt_model: PathBuf,
	pub stt_tokens: PathBuf,
	pub qwen3_conv_frontend: PathBuf,
	pub qwen3_encoder: PathBuf,
	pub qwen3_decoder: PathBuf,
	/// A directory: `vocab.json`, `merges.txt` and `tokenizer_config.json`.
	pub qwen3_tokenizer: PathBuf,
}

impl ModelPaths {
	pub fn under(dir: &Path) -> Self {
		let kws = dir.join(KWS_DIR);
		let stt = dir.join(STT_DIR);
		let qwen3 = dir.join(QWEN3_DIR);
		Self {
			kws_encoder: kws.join(format!("encoder-{KWS_STEM}")),
			kws_decoder: kws.join(format!("decoder-{KWS_STEM}")),
			kws_joiner: kws.join(format!("joiner-{KWS_STEM}")),
			kws_tokens: kws.join("tokens.txt"),
			kws_bpe: kws.join("bpe.model"),
			vad: dir.join(VAD_FILE),
			stt_model: stt.join("model.int8.onnx"),
			stt_tokens: stt.join("tokens.txt"),
			qwen3_conv_frontend: qwen3.join("conv_frontend.onnx"),
			qwen3_encoder: qwen3.join("encoder.int8.onnx"),
			qwen3_decoder: qwen3.join("decoder.int8.onnx"),
			qwen3_tokenizer: qwen3.join("tokenizer"),
		}
	}

	/// Swap in a fine-tuned spotter, as `training/wake/export.sh` lays one
	/// out: `{encoder,decoder,joiner}.int8.onnx`, `tokens.txt`, `bpe.model`.
	pub fn with_spotter(mut self, dir: &Path) -> Self {
		self.kws_encoder = dir.join("encoder.int8.onnx");
		self.kws_decoder = dir.join("decoder.int8.onnx");
		self.kws_joiner = dir.join("joiner.int8.onnx");
		self.kws_tokens = dir.join("tokens.txt");
		self.kws_bpe = dir.join("bpe.model");
		self
	}

	/// The paths `config` asks for.
	pub fn of(config: &SherpaConfig) -> Self {
		let paths = Self::under(&config.models);
		match &config.spotter {
			Some(dir) => paths.with_spotter(dir),
			None => paths,
		}
	}

	/// The recogniser's files.
	fn recogniser_files(&self, recogniser: Recogniser) -> Vec<PathBuf> {
		match recogniser {
			Recogniser::SenseVoice => vec![self.stt_model.clone(), self.stt_tokens.clone()],
			Recogniser::Qwen3 => {
				let mut files = vec![self.qwen3_conv_frontend.clone(), self.qwen3_encoder.clone(), self.qwen3_decoder.clone()];
				files.extend(
					["vocab.json", "merges.txt", "tokenizer_config.json"].map(|name| self.qwen3_tokenizer.join(name)),
				);
				files
			}
		}
	}

	/// Every file, so a missing one is named before anything loads. The
	/// spotter's only if it is to be used, and only the recogniser's that is.
	fn check(&self, spotter: bool, recogniser: Recogniser) -> Result<(), ModelError> {
		let spotter_files = [&self.kws_encoder, &self.kws_decoder, &self.kws_joiner, &self.kws_tokens, &self.kws_bpe];
		let others = std::iter::once(self.vad.clone()).chain(self.recogniser_files(recogniser));
		for path in spotter_files.into_iter().filter(|_| spotter).cloned().chain(others) {
			if !path.is_file() {
				return Err(ModelError::Missing(path));
			}
		}
		Ok(())
	}
}

fn path_string(path: &Path) -> String {
	path.to_string_lossy().into_owned()
}

fn read(path: &Path) -> Result<Vec<u8>, ModelError> {
	std::fs::read(path).map_err(|error| ModelError::Load {
		what: "a model file",
		reason: format!("{}: {error}", path.display()),
	})
}

/// Load everything: the per-speaker model factory and the recogniser.
pub fn load(config: &SherpaConfig) -> Result<(Arc<SherpaModels>, OfflineRecogniser), ModelError> {
	let paths = ModelPaths::of(config);
	paths.check(config.classifier.is_none(), config.recogniser)?;
	let models = SherpaModels::load(&paths, config)?;
	let recogniser = OfflineRecogniser::load(
		&paths,
		config.recogniser,
		config.recogniser_threads,
		config.recogniser_provider,
		&config.recogniser_language,
	)?;
	Ok((Arc::new(models), recogniser))
}

/// The wake word model, shared, and what each speaker's VAD is made from.
pub struct SherpaModels {
	wake: Wake,
	vad: VadModelConfig,
}

/// What hears the name.
enum Wake {
	Spotter(Arc<KeywordSpotter>),
	Classifier(Arc<Classifier>),
}

impl SherpaModels {
	fn load(paths: &ModelPaths, config: &SherpaConfig) -> Result<Self, ModelError> {
		let wake = match &config.classifier {
			Some(dir) => Wake::Classifier(Classifier::load(dir)?),
			None => Wake::Spotter(Arc::new(load_spotter(paths, config)?)),
		};

		let vad = VadModelConfig {
			silero_vad: SileroVadModelConfig {
				model: Some(path_string(&paths.vad)),
				threshold: config.vad_threshold,
				// The gate decides how much silence ends a command. Silero's
				// own hysteresis is kept short so the two do not add up.
				min_silence_duration: 0.05,
				min_speech_duration: 0.05,
				window_size: 512,
				// Longer than any window the gate keeps, so it never splits
				// one.
				max_speech_duration: 8.0,
			},
			sample_rate: SAMPLE_RATE as i32,
			num_threads: 1,
			provider: Some("cpu".to_owned()),
			..Default::default()
		};
		// Made once now, so a bad file fails at startup rather than on the
		// first speaker.
		VoiceActivityDetector::create(&vad, VAD_BUFFER_SECONDS)
			.ok_or(ModelError::Load { what: "the VAD", reason: "sherpa-onnx refused it".to_owned() })?;

		Ok(Self { wake, vad })
	}
}

/// The keyword spotter, with the keywords spelled for it.
fn load_spotter(paths: &ModelPaths, config: &SherpaConfig) -> Result<KeywordSpotter, ModelError> {
	// Spelled and checked here, because a bad line inside sherpa-onnx exits
	// the process.
	let vocabulary = Vocabulary::from_sentencepiece(&read(&paths.kws_bpe)?)?;
	let tokens = keywords::token_set(&String::from_utf8_lossy(&read(&paths.kws_tokens)?));
	let lines = keywords::spotter_lines(
		&keywords::parse(&config.keywords)?,
		&vocabulary,
		&tokens,
		config.keyword_boost,
		config.keyword_threshold,
	)?;

	let mut spotter = KeywordSpotterConfig::default();
	spotter.model_config.transducer.encoder = Some(path_string(&paths.kws_encoder));
	spotter.model_config.transducer.decoder = Some(path_string(&paths.kws_decoder));
	spotter.model_config.transducer.joiner = Some(path_string(&paths.kws_joiner));
	spotter.model_config.tokens = Some(path_string(&paths.kws_tokens));
	spotter.model_config.num_threads = 1;
	spotter.model_config.provider = Some(config.spotter_provider.onnx().to_owned());
	spotter.keywords_buf = Some(lines);
	// The decoder needs a moment of nothing after a keyword before it
	// commits to it; one blank frame keeps that moment short.
	spotter.num_trailing_blanks = 1;
	spotter.keywords_score = config.keyword_boost;
	spotter.keywords_threshold = config.keyword_threshold;
	KeywordSpotter::create(&spotter)
		.ok_or(ModelError::Load { what: "the keyword spotter", reason: "sherpa-onnx refused it".to_owned() })
}

/// Audio the VAD holds on to. Its segments are thrown away as they come (the
/// gate keeps its own window), so this only has to outlast one.
const VAD_BUFFER_SECONDS: f32 = 10.0;

impl Models for SherpaModels {
	fn spotter(&self) -> Result<Box<dyn Spotter>, ModelError> {
		Ok(match &self.wake {
			Wake::Spotter(spotter) => {
				Box::new(SherpaSpotter { stream: spotter.create_stream(), spotter: Arc::clone(spotter), fed: 0 })
			}
			Wake::Classifier(classifier) => Box::new(classifier.spotter()),
		})
	}

	fn vad(&self) -> Result<Box<dyn Vad>, ModelError> {
		let vad = VoiceActivityDetector::create(&self.vad, VAD_BUFFER_SECONDS)
			.ok_or(ModelError::Load { what: "the VAD", reason: "sherpa-onnx refused it".to_owned() })?;
		Ok(Box::new(SherpaVad(vad)))
	}
}

/// The spotter's usual lag, in seconds, for when its own report of one cannot
/// be believed. Measured: 280–480ms on synthesised speech, and 360 and 560ms
/// on the first wake of a real recording.
const TYPICAL_LAG: f64 = 0.45;
/// Lags outside this, in seconds, are not lags.
const PLAUSIBLE_LAG: std::ops::RangeInclusive<f64> = 0.1..=1.0;

struct SherpaSpotter {
	spotter: Arc<KeywordSpotter>,
	stream: OnlineStream,
	/// Samples fed since the stream began; the result's timestamps count from
	/// there.
	fed: usize,
}

impl Spotter for SherpaSpotter {
	fn accept(&mut self, samples: &[f32]) -> Option<Detection> {
		self.stream.accept_waveform(SAMPLE_RATE as i32, samples);
		self.fed += samples.len();
		let mut detection = None;
		while self.spotter.is_ready(&self.stream) {
			self.spotter.decode(&self.stream);
			if let Some(result) = self.spotter.get_result(&self.stream)
				&& !result.keyword.is_empty()
			{
				// The last token's time is where the keyword ended, near
				// enough; everything fed after it is the spotter's lag.
				//
				// Only the first wake on a stream can be measured that way.
				// After a reset the timestamps count from somewhere
				// sherpa-onnx does not say (`start_time` stays 0): on a
				// recording with nine wakes, every one after the first put
				// the name's end under a second "in", wherever it was, for
				// lags of three to five seconds. Believed, those opened the
				// window a second early and left the name inside the
				// command, so an implausible lag gives way to the usual one.
				let end = f64::from(result.timestamps.last().copied().unwrap_or(result.start_time).max(0.0));
				let measured = self.fed as f64 / f64::from(SAMPLE_RATE) - end;
				let lag = if PLAUSIBLE_LAG.contains(&measured) { measured } else { TYPICAL_LAG };
				detection = Some(Detection {
					keyword: keywords::phrase(&result.keyword),
					lag: (lag * f64::from(SAMPLE_RATE)) as usize,
				});
				self.spotter.reset(&self.stream);
			}
		}
		detection
	}

	fn reset(&mut self) {
		self.spotter.reset(&self.stream);
	}
}

struct SherpaVad(VoiceActivityDetector);

impl Vad for SherpaVad {
	fn accept(&mut self, samples: &[f32]) -> bool {
		self.0.accept_waveform(samples);
		let speech = self.0.detected();
		// Finished segments queue up inside; the gate has no use for them.
		self.0.clear();
		speech
	}

	fn reset(&mut self) {
		self.0.reset();
	}
}

/// The speech recogniser through the C API, for the language it reports and,
/// for Qwen3-ASR, the language it is pinned to.
pub struct OfflineRecogniser {
	recogniser: *const sys::OfflineRecognizer,
	model: Recogniser,
	/// For Qwen3-ASR: the pinned language, as its code and as the name the
	/// model's prompt takes ("English").
	pinned: Option<(&'static str, CString)>,
	/// The window with silence around it.
	padded: Vec<f32>,
}

/// Silence put either side of a window before it is recognised, in ms.
///
/// SenseVoice drops the first syllables of audio that starts mid-speech.
/// Measured on a synthesised "Amra, skip this song.": the whole clip came back
/// exactly, the same words cut to the gate's window came back "Sip this song."
/// With silence in front, the window reads like the whole clip again.
/// Measured at 0, 100, 300 and 500ms: 300 recovered the most words for about
/// 30ms more recognition time.
const PADDING_MS: u32 = 300;

/// Qwen3-ASR's name for each of [`LANGUAGES`], as its prompt spells it.
fn qwen3_language(code: &str) -> Option<&'static str> {
	Some(match code {
		"en" => "English",
		"zh" => "Chinese",
		"ja" => "Japanese",
		"ko" => "Korean",
		"yue" => "Cantonese",
		_ => return None,
	})
}

/// The most words a command is expected to come to, in Qwen3-ASR's tokens.
/// Its windows are at most 8s, a few dozen tokens even spoken fast; the cap
/// only stops a decoder that has started repeating itself.
const QWEN3_MAX_NEW_TOKENS: i32 = 96;

// SAFETY: the recogniser is only ever used from one thread at a time (it is
// owned by the recogniser thread), and sherpa-onnx does not tie it to the
// thread that made it.
unsafe impl Send for OfflineRecogniser {}

impl OfflineRecogniser {
	pub fn load(
		paths: &ModelPaths,
		model: Recogniser,
		threads: i32,
		provider: Provider,
		language: &str,
	) -> Result<Self, ModelError> {
		let what = match model {
			Recogniser::Qwen3 => "Qwen3-ASR",
			Recogniser::SenseVoice => "SenseVoice",
		};
		let cstring = |text: String| {
			CString::new(text).map_err(|_| ModelError::Load { what, reason: "a path contains a NUL byte".to_owned() })
		};
		let path = |path: &Path| cstring(path_string(path));
		if language != "auto" && !LANGUAGES.contains(&language) {
			return Err(ModelError::Load {
				what,
				reason: format!("unknown language {language:?}; use auto, {}", LANGUAGES.join(", ")),
			});
		}
		let provider = cstring(provider.onnx().to_owned())?;
		let decoding = cstring("greedy_search".to_owned())?;
		// Every string the config points at, kept alive until it is made.
		let mut strings = Vec::new();
		let mut pinned = None;
		match model {
			Recogniser::SenseVoice => {
				strings.extend([path(&paths.stt_model)?, path(&paths.stt_tokens)?, cstring(language.to_owned())?]);
			}
			Recogniser::Qwen3 => {
				strings.extend([
					path(&paths.qwen3_conv_frontend)?,
					path(&paths.qwen3_encoder)?,
					path(&paths.qwen3_decoder)?,
					path(&paths.qwen3_tokenizer)?,
				]);
				if let (Some(code), Some(name)) =
					(LANGUAGES.iter().find(|code| **code == language), qwen3_language(language))
				{
					pinned = Some((*code, cstring(name.to_owned())?));
				}
			}
		}

		// SAFETY: the config is plain C data — pointers, integers and floats —
		// for which all-zero is the documented "unset" value, as the C API's
		// own examples initialise it with memset. Every pointer set below
		// outlives the create call, which copies what it needs.
		let recogniser = unsafe {
			let mut config: sys::OfflineRecognizerConfig = std::mem::zeroed();
			config.feat_config.sample_rate = SAMPLE_RATE as i32;
			match model {
				Recogniser::SenseVoice => {
					config.feat_config.feature_dim = 80;
					config.model_config.sense_voice.model = strings[0].as_ptr();
					config.model_config.tokens = strings[1].as_ptr();
					config.model_config.sense_voice.language = strings[2].as_ptr();
					// Inverse text normalisation: "track three" comes back
					// "track 3", with punctuation.
					config.model_config.sense_voice.use_itn = 1;
				}
				Recogniser::Qwen3 => {
					// Qwen3-ASR makes its own 128-bin features and ignores
					// these, and needs no tokens file beside its tokenizer.
					config.feat_config.feature_dim = 128;
					let qwen3 = &mut config.model_config.qwen3_asr;
					qwen3.conv_frontend = strings[0].as_ptr();
					qwen3.encoder = strings[1].as_ptr();
					qwen3.decoder = strings[2].as_ptr();
					qwen3.tokenizer = strings[3].as_ptr();
					// The rest at sherpa-onnx's defaults, which are greedy:
					// 512 tokens of context in all, which 8s of audio fits
					// in with room to spare.
					qwen3.max_total_len = 512;
					qwen3.max_new_tokens = QWEN3_MAX_NEW_TOKENS;
					qwen3.temperature = 1e-6;
					qwen3.top_p = 0.8;
					qwen3.seed = 42;
				}
			}
			config.model_config.num_threads = threads;
			config.model_config.provider = provider.as_ptr();
			config.decoding_method = decoding.as_ptr();
			sys::SherpaOnnxCreateOfflineRecognizer(&config)
		};
		if recogniser.is_null() {
			return Err(ModelError::Load { what, reason: "sherpa-onnx refused it".to_owned() });
		}
		Ok(Self { recogniser, model, pinned, padded: Vec::new() })
	}
}

impl Drop for OfflineRecogniser {
	fn drop(&mut self) {
		// SAFETY: made by SherpaOnnxCreateOfflineRecognizer, destroyed once.
		unsafe { sys::SherpaOnnxDestroyOfflineRecognizer(self.recogniser) }
	}
}

impl Transcriber for OfflineRecogniser {
	fn transcribe(&mut self, window: &[f32]) -> Result<Transcript, ModelError> {
		let padding = super::samples(PADDING_MS);
		self.padded.clear();
		self.padded.resize(padding, 0.0);
		self.padded.extend_from_slice(window);
		self.padded.resize(self.padded.len() + padding, 0.0);
		let samples = &self.padded;
		let length = i32::try_from(samples.len())
			.map_err(|_| ModelError::Recognition("window too long".to_owned()))?;
		// SAFETY: the stream is made, used and destroyed here, on the
		// recogniser it belongs to; the option strings and the samples outlive
		// the calls, which copy them; the JSON is copied out before it is
		// freed.
		let json = unsafe {
			let stream = sys::SherpaOnnxCreateOfflineStream(self.recogniser);
			if stream.is_null() {
				return Err(ModelError::Recognition("could not make a stream".to_owned()));
			}
			if let Some((_, name)) = &self.pinned {
				sys::SherpaOnnxOfflineStreamSetOption(stream, c"language".as_ptr(), name.as_ptr());
			}
			sys::SherpaOnnxAcceptWaveformOffline(stream, SAMPLE_RATE as i32, samples.as_ptr(), length);
			sys::SherpaOnnxDecodeOfflineStream(self.recogniser, stream);
			let raw: *const c_char = sys::SherpaOnnxGetOfflineStreamResultAsJson(stream);
			let json = (!raw.is_null()).then(|| CStr::from_ptr(raw).to_string_lossy().into_owned());
			if !raw.is_null() {
				sys::SherpaOnnxDestroyOfflineStreamResultJson(raw);
			}
			sys::SherpaOnnxDestroyOfflineStream(stream);
			json
		};
		let json = json.ok_or_else(|| ModelError::Recognition("no result".to_owned()))?;
		let mut transcript = parse_result(&json)?;
		if self.model == Recogniser::Qwen3 {
			transcript.text = transcript.text.trim().to_owned();
			// sherpa-onnx strips the "language English" Qwen3-ASR writes
			// before the text and keeps nothing of it, so the language is
			// the pinned one, or read off the writing.
			transcript.lang = match &self.pinned {
				Some((code, _)) if !transcript.text.is_empty() => Some((*code).to_owned()),
				Some(_) => None,
				None => script_language(&transcript.text).map(str::to_owned),
			};
		}
		Ok(transcript)
	}
}

/// Characters written in Cantonese and not in Mandarin: 嘅, 咗, 佢, 唔 and
/// the like. Qwen3-ASR writes Cantonese as it is spoken, so one of these is
/// enough to answer in the Cantonese voice.
const CANTONESE: &str = "嘅咗佢啲冇喺嚟嘢唔噉嗰啱搵揾攞睇畀諗谂咩冚嘥乜咁";

/// The language a transcript is written in, by its script: any kana is
/// Japanese, any Hangul Korean, Han with a Cantonese-only character
/// Cantonese, other Han Chinese, and Latin letters English. Japanese written
/// in kanji alone reads as Chinese, as does Cantonese that uses none of
/// those characters ("暫停"); the Mandarin voice says it then.
fn script_language(text: &str) -> Option<&'static str> {
	let (mut han, mut cantonese, mut latin) = (false, false, false);
	for c in text.chars() {
		match c {
			'\u{3040}'..='\u{30ff}' | '\u{31f0}'..='\u{31ff}' | '\u{ff66}'..='\u{ff9d}' => return Some("ja"),
			'\u{1100}'..='\u{11ff}' | '\u{3130}'..='\u{318f}' | '\u{ac00}'..='\u{d7af}' => return Some("ko"),
			'\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{f900}'..='\u{faff}' => {
				han = true;
				cantonese |= CANTONESE.contains(c);
			}
			c if c.is_ascii_alphabetic() => latin = true,
			_ => {}
		}
	}
	if cantonese {
		Some("yue")
	} else if han {
		Some("zh")
	} else if latin {
		Some("en")
	} else {
		None
	}
}

#[derive(serde::Deserialize)]
struct RawResult {
	#[serde(default)]
	text: String,
	#[serde(default)]
	lang: String,
}

/// `{"lang": "<|en|>", "text": "skip.", …}` into a [`Transcript`].
fn parse_result(json: &str) -> Result<Transcript, ModelError> {
	let raw: RawResult =
		serde_json::from_str(json).map_err(|error| ModelError::Recognition(format!("bad result: {error}")))?;
	let lang = raw.lang.trim_start_matches("<|").trim_end_matches("|>");
	let lang = match lang {
		"" | "nospeech" | "unk" => None,
		other => Some(other.to_owned()),
	};
	Ok(Transcript { text: raw.text, lang })
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_language_tag_is_unwrapped() {
		let transcript = parse_result(r#"{"lang":"<|ja|>","emotion":"<|NEUTRAL|>","text":"スキップ。"}"#).unwrap();
		assert_eq!(transcript, Transcript { text: "スキップ。".to_owned(), lang: Some("ja".to_owned()) });
		let silent = parse_result(r#"{"lang":"<|nospeech|>","text":""}"#).unwrap();
		assert_eq!(silent.lang, None);
	}

	#[test]
	fn the_language_is_read_off_the_writing() {
		assert_eq!(script_language("Skip this song."), Some("en"));
		assert_eq!(script_language("跳過這首歌"), Some("zh"));
		// Kanji with kana is Japanese, not Chinese.
		assert_eq!(script_language("次の曲を再生して"), Some("ja"));
		assert_eq!(script_language("다음 곡 틀어줘"), Some("ko"));
		assert_eq!(script_language("播放 BTS 的歌"), Some("zh"));
		// Written as Cantonese is spoken, it is Cantonese.
		assert_eq!(script_language("跳過呢首歌啦唔該"), Some("yue"));
		assert_eq!(script_language("佢播緊咩歌"), Some("yue"));
		assert_eq!(script_language("播放 BTS 嘅歌"), Some("yue"));
		// Nothing in it only Cantonese writes: Chinese.
		assert_eq!(script_language("暫停"), Some("zh"));
		assert_eq!(script_language("..."), None);
	}

	/// The spotter ships its own keywords spelled by SentencePiece. Spelling
	/// the same phrases here must give the same pieces, or keywords encode to
	/// sequences the model never emits and silently never fire — which is
	/// what treating its unigram model as BPE once did.
	///
	/// Needs the models (`scripts/download-voice-models.sh`); skipped, not
	/// failed, without them, as in CI.
	#[test]
	fn spelling_matches_the_models_own_keywords() {
		let models = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../models/voice");
		let paths = ModelPaths::under(&models);
		let kws = paths.kws_tokens.parent().unwrap().to_owned();
		let (Ok(raw), Ok(reference)) = (
			std::fs::read_to_string(kws.join("keywords_raw.txt")),
			std::fs::read_to_string(kws.join("keywords.txt")),
		) else {
			eprintln!("skipping: no models in {}", models.display());
			return;
		};
		let vocabulary = Vocabulary::from_sentencepiece(&read(&paths.kws_bpe).unwrap()).unwrap();
		let tokens = keywords::token_set(&String::from_utf8_lossy(&read(&paths.kws_tokens).unwrap()));
		let lines = keywords::spotter_lines(&keywords::parse(&raw).unwrap(), &vocabulary, &tokens, 1.5, 0.25).unwrap();
		let ours: Vec<&str> = lines.lines().map(|line| line.split(" :").next().unwrap()).collect();
		let theirs: Vec<&str> = reference.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
		assert_eq!(ours, theirs);
	}

	#[test]
	fn a_fine_tuned_spotter_replaces_only_the_spotter() {
		let mut config = SherpaConfig::new(PathBuf::from("/models"), String::new());
		config.spotter = Some(PathBuf::from("/trained"));
		let paths = ModelPaths::of(&config);
		for path in [&paths.kws_encoder, &paths.kws_decoder, &paths.kws_joiner, &paths.kws_tokens, &paths.kws_bpe] {
			assert!(path.starts_with("/trained"), "{}", path.display());
		}
		assert_eq!(paths.kws_encoder, Path::new("/trained/encoder.int8.onnx"));
		assert!(paths.stt_model.starts_with("/models") && paths.vad.starts_with("/models"));
	}

	#[test]
	fn a_missing_model_is_named() {
		let error = load(&SherpaConfig::new(PathBuf::from("/nonexistent"), "AMHRA".to_owned())).err().unwrap();
		assert!(matches!(error, ModelError::Missing(path) if path.starts_with("/nonexistent")));
	}
}
