//! The real models, through sherpa-onnx.
//!
//! - **Wake word:** a 3.3M-parameter streaming zipformer keyword spotter
//!   (GigaSpeech). One spotter for the process, one stream per speaker.
//! - **End of speech:** Silero VAD, one small instance per speaker.
//! - **Speech to text:** SenseVoice-Small (FunASR), int8, with the language
//!   detected per window.
//!
//! The keyword spotter and the VAD go through the `sherpa-onnx` crate's safe
//! API. The recogniser does not: that wrapper parses the result JSON into a
//! struct without the detected language, and the language is half of what is
//! wanted from it. So [`SenseVoice`] calls the C API directly — a recogniser,
//! a stream per window, and the JSON read here.
//!
//! Lay the models out with `scripts/download-voice-models.sh`; [`ModelPaths`]
//! names what it fetches.

use std::ffi::{CStr, CString, c_char};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sherpa_onnx::{
	KeywordSpotter, KeywordSpotterConfig, OnlineStream, SileroVadModelConfig, VadModelConfig,
	VoiceActivityDetector,
};
use sherpa_onnx_sys as sys;

use super::keywords::{self, Vocabulary};
use super::{Detection, ModelError, Models, SAMPLE_RATE, Spotter, Transcriber, Transcript, Vad};

const KWS_DIR: &str = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
const KWS_STEM: &str = "epoch-12-avg-2-chunk-16-left-64.int8.onnx";
const STT_DIR: &str = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17";
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
	/// Threads for the recogniser. More shortens each command; there is only
	/// ever one being recognised at a time. Measured on an M5 Pro per command:
	/// 294ms on one thread, 153ms on two, 83ms on four. Two leaves the cores
	/// to the audio threads, which must not miss a 20ms tick.
	pub recogniser_threads: i32,
	/// A fine-tuned keyword spotter to use instead of the stock one: a
	/// directory laid out by `training/wake/export.sh`.
	pub spotter: Option<PathBuf>,
}

impl SherpaConfig {
	pub fn new(models: PathBuf, keywords: String) -> Self {
		Self {
			models,
			keywords,
			keyword_boost: 1.5,
			keyword_threshold: 0.25,
			vad_threshold: 0.5,
			recogniser_threads: 2,
			spotter: None,
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
}

impl ModelPaths {
	pub fn under(dir: &Path) -> Self {
		let kws = dir.join(KWS_DIR);
		let stt = dir.join(STT_DIR);
		Self {
			kws_encoder: kws.join(format!("encoder-{KWS_STEM}")),
			kws_decoder: kws.join(format!("decoder-{KWS_STEM}")),
			kws_joiner: kws.join(format!("joiner-{KWS_STEM}")),
			kws_tokens: kws.join("tokens.txt"),
			kws_bpe: kws.join("bpe.model"),
			vad: dir.join(VAD_FILE),
			stt_model: stt.join("model.int8.onnx"),
			stt_tokens: stt.join("tokens.txt"),
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

	/// Every file, so a missing one is named before anything loads.
	fn check(&self) -> Result<(), ModelError> {
		for path in [
			&self.kws_encoder,
			&self.kws_decoder,
			&self.kws_joiner,
			&self.kws_tokens,
			&self.kws_bpe,
			&self.vad,
			&self.stt_model,
			&self.stt_tokens,
		] {
			if !path.is_file() {
				return Err(ModelError::Missing(path.clone()));
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
pub fn load(config: &SherpaConfig) -> Result<(Arc<SherpaModels>, SenseVoice), ModelError> {
	let paths = ModelPaths::of(config);
	paths.check()?;
	let models = SherpaModels::load(&paths, config)?;
	let recogniser = SenseVoice::load(&paths, config.recogniser_threads)?;
	Ok((Arc::new(models), recogniser))
}

/// The spotter, shared, and what each speaker's VAD is made from.
pub struct SherpaModels {
	spotter: Arc<KeywordSpotter>,
	vad: VadModelConfig,
}

impl SherpaModels {
	fn load(paths: &ModelPaths, config: &SherpaConfig) -> Result<Self, ModelError> {
		// Spelled and checked here, because a bad line inside sherpa-onnx
		// exits the process.
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
		spotter.model_config.provider = Some("cpu".to_owned());
		spotter.keywords_buf = Some(lines);
		// The decoder needs a moment of nothing after a keyword before it
		// commits to it; one blank frame keeps that moment short.
		spotter.num_trailing_blanks = 1;
		spotter.keywords_score = config.keyword_boost;
		spotter.keywords_threshold = config.keyword_threshold;
		let spotter = KeywordSpotter::create(&spotter)
			.ok_or(ModelError::Load { what: "the keyword spotter", reason: "sherpa-onnx refused it".to_owned() })?;

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

		Ok(Self { spotter: Arc::new(spotter), vad })
	}
}

/// Audio the VAD holds on to. Its segments are thrown away as they come (the
/// gate keeps its own window), so this only has to outlast one.
const VAD_BUFFER_SECONDS: f32 = 10.0;

impl Models for SherpaModels {
	fn spotter(&self) -> Result<Box<dyn Spotter>, ModelError> {
		Ok(Box::new(SherpaSpotter {
			stream: self.spotter.create_stream(),
			spotter: Arc::clone(&self.spotter),
			fed: 0,
		}))
	}

	fn vad(&self) -> Result<Box<dyn Vad>, ModelError> {
		let vad = VoiceActivityDetector::create(&self.vad, VAD_BUFFER_SECONDS)
			.ok_or(ModelError::Load { what: "the VAD", reason: "sherpa-onnx refused it".to_owned() })?;
		Ok(Box::new(SherpaVad(vad)))
	}
}

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
				let end = result.timestamps.last().copied().unwrap_or(result.start_time);
				let end = (f64::from(end.max(0.0)) * f64::from(SAMPLE_RATE)) as usize;
				detection = Some(Detection {
					keyword: keywords::phrase(&result.keyword),
					lag: self.fed.saturating_sub(end),
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

/// SenseVoice-Small through the C API, for the language it reports.
pub struct SenseVoice {
	recogniser: *const sys::OfflineRecognizer,
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

// SAFETY: the recogniser is only ever used from one thread at a time (it is
// owned by the recogniser thread), and sherpa-onnx does not tie it to the
// thread that made it.
unsafe impl Send for SenseVoice {}

impl SenseVoice {
	pub fn load(paths: &ModelPaths, threads: i32) -> Result<Self, ModelError> {
		let cstring = |text: String| {
			CString::new(text).map_err(|_| ModelError::Load {
				what: "SenseVoice",
				reason: "a path contains a NUL byte".to_owned(),
			})
		};
		let model = cstring(path_string(&paths.stt_model))?;
		let tokens = cstring(path_string(&paths.stt_tokens))?;
		let language = cstring("auto".to_owned())?;
		let provider = cstring("cpu".to_owned())?;
		let decoding = cstring("greedy_search".to_owned())?;

		// SAFETY: the config is plain C data — pointers, integers and floats —
		// for which all-zero is the documented "unset" value, as the C API's
		// own examples initialise it with memset. Every pointer set below
		// outlives the create call, which copies what it needs.
		let recogniser = unsafe {
			let mut config: sys::OfflineRecognizerConfig = std::mem::zeroed();
			config.feat_config.sample_rate = SAMPLE_RATE as i32;
			config.feat_config.feature_dim = 80;
			config.model_config.sense_voice.model = model.as_ptr();
			config.model_config.sense_voice.language = language.as_ptr();
			// Inverse text normalisation: "track three" comes back "track 3",
			// with punctuation.
			config.model_config.sense_voice.use_itn = 1;
			config.model_config.tokens = tokens.as_ptr();
			config.model_config.num_threads = threads;
			config.model_config.provider = provider.as_ptr();
			config.decoding_method = decoding.as_ptr();
			sys::SherpaOnnxCreateOfflineRecognizer(&config)
		};
		if recogniser.is_null() {
			return Err(ModelError::Load { what: "SenseVoice", reason: "sherpa-onnx refused it".to_owned() });
		}
		Ok(Self { recogniser, padded: Vec::new() })
	}
}

impl Drop for SenseVoice {
	fn drop(&mut self) {
		// SAFETY: made by SherpaOnnxCreateOfflineRecognizer, destroyed once.
		unsafe { sys::SherpaOnnxDestroyOfflineRecognizer(self.recogniser) }
	}
}

impl Transcriber for SenseVoice {
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
		// recogniser it belongs to; the samples outlive the accept call, which
		// copies them; the JSON is copied out before it is freed.
		let json = unsafe {
			let stream = sys::SherpaOnnxCreateOfflineStream(self.recogniser);
			if stream.is_null() {
				return Err(ModelError::Recognition("could not make a stream".to_owned()));
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
		parse_result(&json)
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
