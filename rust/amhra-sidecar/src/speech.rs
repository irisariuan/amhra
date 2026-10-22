//! The bot saying what it is doing: "Skipping.", "Paused.", over the music.
//!
//! Built for a small computer, a Raspberry Pi class board, where a speech
//! model costs seconds of CPU for every phrase and Kokoro takes 700 MB once
//! loaded. Most of what the bot says is the same few dozen phrases. Those the
//! bot names with `prepare` are synthesised once, ahead of time, saved under
//! the cache directory, and from then on only read back. The rest ("Playing
//! bad guy.") is synthesised when it is said and remembered for a while, but
//! not saved, so the store stays the size of the fixed phrases.
//!
//! Each language has its own model (see [`models`]): Supertonic for English,
//! Japanese and Korean, Kokoro for Mandarin, a VITS voice for Cantonese. Each
//! is loaded only to say something new in its language, and let go after a
//! minute of nothing new in it.
//!
//! One thread does all of it, so at most one core is ever busy with speech.
//! What is to be said now goes before what is being prepared, and is given up
//! if it could not be said soon enough to still make sense.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::time::{Duration, Instant};

/// The rate and layout the worker mixes in: interleaved stereo at 48 kHz.
const OPUS_RATE: u32 = 48_000;

/// Peak level, as a fraction of full scale. The music is lowered under it.
const LEVEL: f32 = 0.4;

/// Below this fraction of the peak, the start and end of a phrase are
/// silence. Supertonic pads every phrase with nearly half a second of it.
const QUIET: f32 = 0.02;

/// Silence kept either side of a trimmed phrase, in ms, so it does not start
/// or stop abruptly.
const MARGIN_MS: u64 = 60;

/// How long a model stays loaded with nothing new to say in its languages.
const IDLE: Duration = Duration::from_secs(60);

/// Asked longer ago than this, a phrase is saved but not said: "Skipping"
/// several seconds after the skip is noise.
const STALE: Duration = Duration::from_secs(8);

/// Phrases kept in memory, about 200 KB a second of speech each.
const REMEMBERED: usize = 64;

/// The languages the bot answers aloud in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Voice {
	English,
	Japanese,
	Korean,
	Mandarin,
	Cantonese,
}

impl Voice {
	/// The voice for a language code as the bot sends it: `en`, `ja`, `ko`,
	/// `zh` or `yue`. Anything else is English.
	pub fn for_language(language: Option<&str>) -> Self {
		match language {
			Some("ja") => Self::Japanese,
			Some("ko") => Self::Korean,
			Some("zh") => Self::Mandarin,
			Some("yue") => Self::Cantonese,
			_ => Self::English,
		}
	}

	pub fn name(self) -> &'static str {
		match self {
			Self::English => "en",
			Self::Japanese => "ja",
			Self::Korean => "ko",
			Self::Mandarin => "zh",
			Self::Cantonese => "yue",
		}
	}

	/// What says this voice's text when no model speaks it. Cantonese is
	/// answered in written Chinese, which a Mandarin voice can read; kana and
	/// hangul have nothing else to read them.
	fn fallback(self) -> Option<Self> {
		(self == Self::Cantonese).then_some(Self::Mandarin)
	}
}

/// Text to speech.
pub trait Synthesiser {
	/// `text` said in `voice`: mono samples in -1..1, and their rate.
	fn speak(&mut self, text: &str, voice: Voice) -> Result<(Vec<f32>, u32), String>;
}

/// Loads a model. Called on the speech thread, each time it is needed after
/// having been let go.
pub type Load = Box<dyn FnMut() -> Result<Box<dyn Synthesiser>, String> + Send>;

/// Hands a guild's worker what to play.
pub type Deliver = Box<dyn Fn(&str, Arc<[i16]>) + Send>;

/// A speech model and the voices it says.
pub struct Model {
	/// Names the folder its phrases are saved in, so another model's phrases
	/// are never read back as its own.
	pub name: String,
	/// The first model in the list that speaks a voice says it.
	pub voices: Vec<Voice>,
	pub load: Load,
}

enum Request {
	Say { guild_id: String, text: String, voice: Voice, asked: Instant },
	Prepare { text: String, voice: Voice },
}

/// The speech thread.
pub struct Speech {
	requests: Sender<Request>,
}

impl Speech {
	/// Start the thread. `store` is where prepared phrases are saved; without
	/// one they are kept in memory only, and synthesised again after a restart.
	pub fn start(models: Vec<Model>, store: Option<PathBuf>, deliver: Deliver) -> std::io::Result<Self> {
		let (requests, inbox) = std::sync::mpsc::channel();
		if let Some(store) = &store {
			for model in &models {
				std::fs::create_dir_all(store.join(&model.name))?;
			}
		}
		std::thread::Builder::new().name("speech".to_owned()).spawn(move || run(&inbox, models, store, &deliver))?;
		Ok(Self { requests })
	}

	/// Say `text` in this guild's call.
	pub fn say(&self, guild_id: String, text: String, voice: Voice) {
		let _ = self.requests.send(Request::Say { guild_id, text, voice, asked: Instant::now() });
	}

	/// Have `text` ready to say, synthesising it now if it is not saved.
	pub fn prepare(&self, text: String, voice: Voice) {
		let _ = self.requests.send(Request::Prepare { text, voice });
	}
}

/// A model on the speech thread: loaded or not, and when it last spoke.
struct Slot {
	model: Model,
	loaded: Option<Box<dyn Synthesiser>>,
	used: Instant,
	/// It would not load, and has said so; not said again on every phrase.
	failed: bool,
}

impl Slot {
	/// The model's rendering of `text`, loading it first if it was let go.
	fn synthesise(&mut self, text: &str, voice: Voice) -> Option<Arc<[i16]>> {
		if self.loaded.is_none() {
			let started = Instant::now();
			match (self.model.load)() {
				Ok(loaded) => {
					eprintln!("speech: {} loaded in {:?}", self.model.name, started.elapsed());
					self.loaded = Some(loaded);
					self.failed = false;
				}
				Err(error) => {
					if !self.failed {
						eprintln!("speech: cannot load {}: {error}", self.model.name);
					}
					self.failed = true;
					return None;
				}
			}
		}
		let started = Instant::now();
		let spoken = self.loaded.as_mut()?.speak(text, voice);
		self.used = Instant::now();
		match spoken {
			Ok((samples, rate)) => {
				eprintln!(
					"speech: {} said {} chars of {} in {:?}",
					self.model.name,
					text.chars().count(),
					voice.name(),
					started.elapsed()
				);
				Some(to_opus_pcm(&samples, rate).into())
			}
			Err(error) => {
				eprintln!("speech: {} could not say a phrase: {error}", self.model.name);
				None
			}
		}
	}
}

/// The slot that says `voice`, and the voice it says it in.
fn speaker(slots: &[Slot], voice: Voice) -> Option<(usize, Voice)> {
	let find = |voice: Voice| slots.iter().position(|slot| slot.model.voices.contains(&voice)).map(|at| (at, voice));
	find(voice).or_else(|| voice.fallback().and_then(find))
}

fn run(inbox: &Receiver<Request>, models: Vec<Model>, store: Option<PathBuf>, deliver: &Deliver) {
	let mut slots: Vec<Slot> =
		models.into_iter().map(|model| Slot { model, loaded: None, used: Instant::now(), failed: false }).collect();
	let mut remembered: HashMap<(usize, Voice, String), Arc<[i16]>> = HashMap::new();
	let mut unspoken = HashSet::new();
	let mut saying = VecDeque::new();
	let mut preparing = VecDeque::new();
	loop {
		// Take everything waiting, so what is to be said now can go first.
		loop {
			match inbox.try_recv() {
				Ok(request @ Request::Say { .. }) => saying.push_back(request),
				Ok(request @ Request::Prepare { .. }) => preparing.push_back(request),
				Err(TryRecvError::Empty) => break,
				Err(TryRecvError::Disconnected) => return,
			}
		}
		let Some(request) = saying.pop_front().or_else(|| preparing.pop_front()) else {
			let next_idle = slots.iter().filter(|slot| slot.loaded.is_some()).map(|slot| slot.used + IDLE).min();
			let wait = next_idle.map_or(Duration::MAX, |at| at.saturating_duration_since(Instant::now()));
			match inbox.recv_timeout(wait) {
				Ok(request @ Request::Say { .. }) => saying.push_back(request),
				Ok(request @ Request::Prepare { .. }) => preparing.push_back(request),
				Err(RecvTimeoutError::Timeout) => {
					let now = Instant::now();
					for slot in slots.iter_mut().filter(|slot| slot.loaded.is_some() && now >= slot.used + IDLE) {
						eprintln!("speech: letting {} go", slot.model.name);
						slot.loaded = None;
					}
				}
				Err(RecvTimeoutError::Disconnected) => return,
			}
			continue;
		};
		let (text, asked_voice) = match &request {
			Request::Say { text, voice, .. } | Request::Prepare { text, voice } => (text.clone(), *voice),
		};
		let Some((at, voice)) = speaker(&slots, asked_voice) else {
			if unspoken.insert(asked_voice) {
				eprintln!("speech: no model says {}", asked_voice.name());
			}
			continue;
		};
		let slot = &mut slots[at];
		let prepared = matches!(request, Request::Prepare { .. });
		let path = store.as_ref().map(|store| store.join(&slot.model.name).join(file_name(&text, voice)));
		let key = (at, voice, text);
		let known = remembered.get(&key).cloned().or_else(|| path.as_deref().and_then(read));
		let saved = known.is_some() && path.as_ref().is_some_and(|path| path.is_file());
		let pcm = known.or_else(|| slot.synthesise(&key.2, voice));
		// Only the phrases the bot prepares are saved: the rest are song
		// titles and numbers, which would grow the store without end.
		if let (true, false, Some(path), Some(pcm)) = (prepared, saved, &path, &pcm)
			&& let Err(error) = write(path, pcm)
		{
			eprintln!("speech: could not save {}: {error}", path.display());
		}
		if let Some(pcm) = &pcm
			&& !remembered.contains_key(&key)
		{
			if remembered.len() >= REMEMBERED {
				remembered.clear();
			}
			remembered.insert(key, Arc::clone(pcm));
		}
		if let (Some(pcm), Request::Say { guild_id, asked, .. }) = (pcm, request)
			&& asked.elapsed() <= STALE
		{
			deliver(&guild_id, pcm);
		}
	}
}

/// Mono samples at `rate` as the worker plays them: interleaved stereo at the
/// Opus rate, peaking at `LEVEL`, without the silence the model put around
/// them. Linear interpolation is plenty for speech going up from 24 kHz.
pub fn to_opus_pcm(samples: &[f32], rate: u32) -> Vec<i16> {
	let peak = samples.iter().filter(|sample| sample.is_finite()).fold(0f32, |peak, sample| peak.max(sample.abs()));
	if samples.is_empty() || rate == 0 || peak == 0.0 {
		return Vec::new();
	}
	let loud = |sample: &f32| sample.is_finite() && sample.abs() > peak * QUIET;
	let margin = (u64::from(rate) * MARGIN_MS / 1000) as usize;
	let start = samples.iter().position(loud).unwrap_or(0).saturating_sub(margin);
	let end = (samples.iter().rposition(loud).map_or(samples.len(), |at| at + 1) + margin).min(samples.len());
	let samples = &samples[start..end];

	let gain = LEVEL / peak * f32::from(i16::MAX);
	let length = (samples.len() as u64 * u64::from(OPUS_RATE) / u64::from(rate)) as usize;
	let step = f64::from(rate) / f64::from(OPUS_RATE);
	let mut pcm = Vec::with_capacity(length * 2);
	for index in 0..length {
		let at = index as f64 * step;
		let before = at.floor() as usize;
		let after = (before + 1).min(samples.len() - 1);
		let between = (at - before as f64) as f32;
		let value = samples[before] * (1.0 - between) + samples[after] * between;
		let value = if value.is_finite() { (value * gain) as i16 } else { 0 };
		pcm.extend([value, value]);
	}
	pcm
}

/// Where a phrase is saved: by voice and a hash of the text, so any text is a
/// safe file name. FNV-1a, because it must not change between builds.
fn file_name(text: &str, voice: Voice) -> String {
	let hash = text
		.bytes()
		.fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3));
	format!("{}-{hash:016x}.pcm", voice.name())
}

fn read(path: &std::path::Path) -> Option<Arc<[i16]>> {
	let bytes = std::fs::read(path).ok()?;
	Some(bytes.as_chunks::<2>().0.iter().map(|pair| i16::from_le_bytes(*pair)).collect())
}

/// Save through a temporary file, so a phrase cut off half written is never
/// read back.
fn write(path: &std::path::Path, pcm: &[i16]) -> std::io::Result<()> {
	let bytes: Vec<u8> = pcm.iter().flat_map(|sample| sample.to_le_bytes()).collect();
	let partial = path.with_extension("partial");
	std::fs::write(&partial, bytes)?;
	std::fs::rename(partial, path)
}

/// The models, through sherpa-onnx, as its releases unpack them.
///
/// Measured with `examples/tts_check.rs` on one thread of an M5 Pro, as
/// SenseVoice heard them back (rust/README.md): Supertonic 3 says a phrase in
/// about 450 ms, a quarter of real time, as clearly as Kokoro does English;
/// Kokoro has no Japanese or Korean as sherpa-onnx runs it, and takes 860 to
/// 1170 ms; the Cantonese voice takes about 610 ms.
#[cfg(feature = "voice-commands")]
pub mod models {
	use std::collections::HashMap;
	use std::path::{Path, PathBuf};

	use super::{Load, Model, Synthesiser, Voice};
	use sherpa_onnx::{
		GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig, OfflineTtsModelConfig,
		OfflineTtsSupertonicModelConfig, OfflineTtsVitsModelConfig,
	};

	/// Kokoro v1.0, fp32: the int8 one only says NaN on Apple silicon.
	pub const KOKORO: &str = "kokoro-multi-lang-v1_0";
	/// Supertonic 3, int8. 31 languages, but no Chinese.
	pub const SUPERTONIC: &str = "sherpa-onnx-supertonic-3-tts-int8-2026-05-11";
	/// The one Cantonese voice sherpa-onnx has.
	pub const CANTONESE: &str = "vits-cantonese-hf-xiaomaiiwn";

	/// Supertonic's voice: the first of its ten, female, nearest Kokoro's
	/// af_heart in pitch (about 190 Hz against 210).
	const SUPERTONIC_VOICE: i32 = 0;

	/// The speech models unpacked under `dir`, each to speak what it says
	/// best: Supertonic before Kokoro, so English is Supertonic's when both
	/// are there.
	pub fn under(dir: &Path, threads: i32) -> Vec<Model> {
		let mut models = Vec::new();
		let mut add = |name: &str, voices: Vec<Voice>, load: fn(PathBuf, i32) -> Load| {
			let path = dir.join(name);
			if path.is_dir() {
				models.push(Model { name: name.to_owned(), voices, load: load(path, threads) });
			}
		};
		add(SUPERTONIC, vec![Voice::English, Voice::Japanese, Voice::Korean], supertonic);
		add(KOKORO, vec![Voice::Mandarin, Voice::English], kokoro);
		add(CANTONESE, vec![Voice::Cantonese], cantonese);
		models
	}

	fn cpu(threads: i32, provider: &str) -> OfflineTtsModelConfig {
		OfflineTtsModelConfig {
			vits: Default::default(),
			matcha: Default::default(),
			kokoro: Default::default(),
			kitten: Default::default(),
			zipvoice: Default::default(),
			pocket: Default::default(),
			supertonic: Default::default(),
			num_threads: threads,
			debug: false,
			provider: Some(provider.to_owned()),
		}
	}

	/// `kokoro-multi-lang-v1_0`, unpacked in `dir`.
	pub fn kokoro_config(dir: &str, threads: i32, provider: &str, lang: Option<String>) -> OfflineTtsConfig {
		let file = |name: &str| Some(format!("{dir}/{name}"));
		OfflineTtsConfig {
			model: OfflineTtsModelConfig {
				kokoro: OfflineTtsKokoroModelConfig {
					model: file("model.onnx"),
					voices: file("voices.bin"),
					tokens: file("tokens.txt"),
					data_dir: file("espeak-ng-data"),
					dict_dir: file("dict"),
					lexicon: Some(format!("{dir}/lexicon-us-en.txt,{dir}/lexicon-zh.txt")),
					lang,
					..OfflineTtsKokoroModelConfig::default()
				},
				..cpu(threads, provider)
			},
			rule_fsts: Some(format!("{dir}/date-zh.fst,{dir}/phone-zh.fst,{dir}/number-zh.fst")),
			max_num_sentences: 1,
			..OfflineTtsConfig::default()
		}
	}

	/// Supertonic 3's int8 release, unpacked in `dir`.
	pub fn supertonic_config(dir: &str, threads: i32) -> OfflineTtsConfig {
		let file = |name: &str| Some(format!("{dir}/{name}"));
		OfflineTtsConfig {
			model: OfflineTtsModelConfig {
				supertonic: OfflineTtsSupertonicModelConfig {
					duration_predictor: file("duration_predictor.int8.onnx"),
					text_encoder: file("text_encoder.int8.onnx"),
					vector_estimator: file("vector_estimator.int8.onnx"),
					vocoder: file("vocoder.int8.onnx"),
					tts_json: file("tts.json"),
					unicode_indexer: file("unicode_indexer.bin"),
					voice_style: file("voice.bin"),
				},
				..cpu(threads, "cpu")
			},
			max_num_sentences: 1,
			..OfflineTtsConfig::default()
		}
	}

	/// A VITS voice from sherpa-onnx's releases, unpacked in `dir`: its one
	/// `.onnx`, and whichever of a lexicon, tokens, espeak data and text rules
	/// it came with.
	pub fn vits_config(dir: &str, threads: i32) -> OfflineTtsConfig {
		let names: Vec<String> = std::fs::read_dir(dir)
			.map(|entries| entries.filter_map(|entry| entry.ok()?.file_name().into_string().ok()).collect())
			.unwrap_or_default();
		let file = |name: &str| Path::new(dir).join(name).exists().then(|| format!("{dir}/{name}"));
		let with = |suffix: &str| -> Vec<String> {
			names.iter().filter(|name| name.ends_with(suffix)).map(|name| format!("{dir}/{name}")).collect()
		};
		let fsts = with(".fst");
		OfflineTtsConfig {
			model: OfflineTtsModelConfig {
				vits: OfflineTtsVitsModelConfig {
					model: with(".onnx").into_iter().next(),
					lexicon: file("lexicon.txt"),
					tokens: file("tokens.txt"),
					data_dir: file("espeak-ng-data"),
					dict_dir: file("dict"),
					..OfflineTtsVitsModelConfig::default()
				},
				..cpu(threads, "cpu")
			},
			rule_fsts: (!fsts.is_empty()).then(|| fsts.join(",")),
			max_num_sentences: 1,
			..OfflineTtsConfig::default()
		}
	}

	fn say(tts: &OfflineTts, text: &str, generation: &GenerationConfig) -> Result<(Vec<f32>, u32), String> {
		let audio = tts
			.generate_with_config(text, generation, None::<fn(&[f32], f32) -> bool>)
			.ok_or("the model said nothing")?;
		Ok((audio.samples().to_vec(), audio.sample_rate() as u32))
	}

	fn create(config: &OfflineTtsConfig, dir: &Path) -> Result<OfflineTts, String> {
		OfflineTts::create(config).ok_or_else(|| format!("sherpa-onnx would not load {}", dir.display()))
	}

	struct Kokoro(OfflineTts);

	impl Synthesiser for Kokoro {
		fn speak(&mut self, text: &str, voice: Voice) -> Result<(Vec<f32>, u32), String> {
			// af_heart and zf_xiaoxiao.
			let sid = match voice {
				Voice::English => 3,
				Voice::Mandarin => 47,
				other => return Err(format!("Kokoro does not speak {}", other.name())),
			};
			say(&self.0, text, &GenerationConfig { sid, ..GenerationConfig::default() })
		}
	}

	fn kokoro(dir: PathBuf, threads: i32) -> Load {
		Box::new(move || {
			let config = kokoro_config(&dir.to_string_lossy(), threads, "cpu", None);
			create(&config, &dir).map(|tts| Box::new(Kokoro(tts)) as Box<dyn Synthesiser>)
		})
	}

	struct Supertonic(OfflineTts);

	impl Synthesiser for Supertonic {
		fn speak(&mut self, text: &str, voice: Voice) -> Result<(Vec<f32>, u32), String> {
			let lang = match voice {
				Voice::English | Voice::Japanese | Voice::Korean => voice.name(),
				other => return Err(format!("Supertonic does not speak {}", other.name())),
			};
			let generation = GenerationConfig {
				sid: SUPERTONIC_VOICE,
				extra: Some(HashMap::from([("lang".to_owned(), serde_json::Value::from(lang))])),
				..GenerationConfig::default()
			};
			say(&self.0, text, &generation)
		}
	}

	fn supertonic(dir: PathBuf, threads: i32) -> Load {
		Box::new(move || {
			let config = supertonic_config(&dir.to_string_lossy(), threads);
			create(&config, &dir).map(|tts| Box::new(Supertonic(tts)) as Box<dyn Synthesiser>)
		})
	}

	struct Cantonese(OfflineTts);

	impl Synthesiser for Cantonese {
		fn speak(&mut self, text: &str, _: Voice) -> Result<(Vec<f32>, u32), String> {
			// Its lexicon is in simplified characters, and a character it
			// does not have is left out: given traditional text it skipped
			// 這 and 過, and twice as much was misheard.
			say(&self.0, &fast2s::convert(text), &GenerationConfig::default())
		}
	}

	fn cantonese(dir: PathBuf, threads: i32) -> Load {
		Box::new(move || {
			let config = vits_config(&dir.to_string_lossy(), threads);
			create(&config, &dir).map(|tts| Box::new(Cantonese(tts)) as Box<dyn Synthesiser>)
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::sync::Mutex;
	use std::sync::atomic::{AtomicUsize, Ordering};

	/// Says a tone as long as the text, counting how often it was asked and
	/// loaded, and which voices.
	struct Fake(Arc<AtomicUsize>, Arc<Mutex<Vec<Voice>>>);

	impl Synthesiser for Fake {
		fn speak(&mut self, text: &str, voice: Voice) -> Result<(Vec<f32>, u32), String> {
			self.0.fetch_add(1, Ordering::SeqCst);
			self.1.lock().unwrap().push(voice);
			Ok((vec![0.5; text.len() * 240], 24_000))
		}
	}

	#[derive(Default, Clone)]
	struct Counts {
		spoken: Arc<AtomicUsize>,
		loads: Arc<AtomicUsize>,
		voices: Arc<Mutex<Vec<Voice>>>,
	}

	fn fake(name: &str, voices: Vec<Voice>, counts: &Counts) -> Model {
		let counts = counts.clone();
		Model {
			name: name.to_owned(),
			voices,
			load: Box::new(move || {
				counts.loads.fetch_add(1, Ordering::SeqCst);
				Ok(Box::new(Fake(Arc::clone(&counts.spoken), Arc::clone(&counts.voices))) as Box<dyn Synthesiser>)
			}),
		}
	}

	type Heard = Arc<Mutex<Vec<(String, usize)>>>;

	fn listener() -> (Heard, Deliver) {
		let heard: Heard = Arc::default();
		let into = Arc::clone(&heard);
		(heard, Box::new(move |guild: &str, pcm: Arc<[i16]>| into.lock().unwrap().push((guild.to_owned(), pcm.len()))))
	}

	fn settle(heard: &Heard, count: usize) {
		let deadline = Instant::now() + Duration::from_secs(5);
		while heard.lock().unwrap().len() < count && Instant::now() < deadline {
			std::thread::sleep(Duration::from_millis(5));
		}
	}

	#[test]
	fn prepared_phrases_are_saved_and_the_rest_remembered() {
		let store = std::env::temp_dir().join(format!("amhra-speech-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&store);
		let counts = Counts::default();

		let (heard, deliver) = listener();
		let models = vec![fake("m", vec![Voice::English, Voice::Mandarin], &counts)];
		let speech = Speech::start(models, Some(store.clone()), deliver).unwrap();
		speech.prepare("Paused.".into(), Voice::English);
		speech.prepare("Skipping.".into(), Voice::English);
		speech.say("g".into(), "Skipping.".into(), Voice::English);
		speech.say("g".into(), "Skipping.".into(), Voice::English);
		speech.say("g".into(), "Playing bad guy.".into(), Voice::English);
		speech.say("g".into(), "Playing bad guy.".into(), Voice::English);
		settle(&heard, 4);
		assert_eq!(counts.spoken.load(Ordering::SeqCst), 3, "each phrase once");
		// 9 characters, 2160 samples at 24 kHz, are 4320 at 48 kHz, twice over.
		assert_eq!(heard.lock().unwrap()[0], ("g".to_owned(), 8640));
		assert_eq!(heard.lock().unwrap().len(), 4);
		std::thread::sleep(Duration::from_millis(50));
		assert_eq!(std::fs::read_dir(store.join("m")).unwrap().count(), 2, "only the prepared phrases are saved");
		drop(speech);

		// After a restart, the prepared ones are read back without the model.
		let counts = Counts::default();
		let (heard, deliver) = listener();
		let models = vec![fake("m", vec![Voice::English, Voice::Mandarin], &counts)];
		let speech = Speech::start(models, Some(store.clone()), deliver).unwrap();
		speech.say("g".into(), "Skipping.".into(), Voice::English);
		speech.say("g".into(), "Paused.".into(), Voice::English);
		settle(&heard, 2);
		assert_eq!(heard.lock().unwrap().len(), 2);
		assert_eq!(counts.loads.load(Ordering::SeqCst), 0);
		// The rest is synthesised again, and another voice is another phrase.
		speech.say("g".into(), "Playing bad guy.".into(), Voice::English);
		speech.say("g".into(), "Skipping.".into(), Voice::Mandarin);
		settle(&heard, 4);
		assert_eq!(counts.spoken.load(Ordering::SeqCst), 2);
		drop(speech);

		// Another model's phrases are its own, even for the same text.
		let counts = Counts::default();
		let (heard, deliver) = listener();
		let speech = Speech::start(vec![fake("other", vec![Voice::English], &counts)], Some(store.clone()), deliver)
			.unwrap();
		speech.say("g".into(), "Skipping.".into(), Voice::English);
		settle(&heard, 1);
		assert_eq!(counts.loads.load(Ordering::SeqCst), 1);
		drop(speech);
		let _ = std::fs::remove_dir_all(&store);
	}

	#[test]
	fn each_language_goes_to_the_first_model_that_speaks_it() {
		let (first, second) = (Counts::default(), Counts::default());
		let models = vec![
			fake("supertonic", vec![Voice::English, Voice::Japanese, Voice::Korean], &first),
			fake("kokoro", vec![Voice::Mandarin, Voice::English], &second),
		];
		let (heard, deliver) = listener();
		let speech = Speech::start(models, None, deliver).unwrap();
		speech.say("g".into(), "Skipping.".into(), Voice::English);
		speech.say("g".into(), "スキップします。".into(), Voice::Japanese);
		speech.say("g".into(), "跳過。".into(), Voice::Mandarin);
		// No Cantonese model: the Mandarin voice reads it.
		speech.say("g".into(), "已暫停。".into(), Voice::Cantonese);
		settle(&heard, 4);
		assert_eq!(*first.voices.lock().unwrap(), vec![Voice::English, Voice::Japanese]);
		assert_eq!(*second.voices.lock().unwrap(), vec![Voice::Mandarin, Voice::Mandarin]);
	}

	#[test]
	fn a_language_no_model_speaks_is_not_said() {
		let counts = Counts::default();
		let (heard, deliver) = listener();
		let speech = Speech::start(vec![fake("kokoro", vec![Voice::Mandarin], &counts)], None, deliver).unwrap();
		speech.say("g".into(), "건너뜁니다.".into(), Voice::Korean);
		speech.say("g".into(), "跳過。".into(), Voice::Mandarin);
		settle(&heard, 1);
		std::thread::sleep(Duration::from_millis(50));
		assert_eq!(heard.lock().unwrap().len(), 1);
		assert_eq!(*counts.voices.lock().unwrap(), vec![Voice::Mandarin]);
	}

	#[test]
	fn a_model_that_will_not_load_says_nothing() {
		let (heard, deliver) = listener();
		let model = Model { name: "m".into(), voices: vec![Voice::English], load: Box::new(|| Err("missing".into())) };
		let speech = Speech::start(vec![model], None, deliver).unwrap();
		speech.say("g".into(), "Skipping.".into(), Voice::English);
		std::thread::sleep(Duration::from_millis(50));
		assert!(heard.lock().unwrap().is_empty());
	}

	#[test]
	fn speech_is_made_stereo_at_the_opus_rate_and_level() {
		let pcm = to_opus_pcm(&[0.0, 0.25, -0.5, 0.0], 24_000);
		assert_eq!(pcm.len(), 16);
		assert_eq!(pcm[0], pcm[1], "both channels");
		let peak = pcm.iter().map(|sample| i32::from(*sample).abs()).max().unwrap();
		assert_eq!(peak, (LEVEL * f32::from(i16::MAX)) as i32);
		// Halfway between 0 and 0.25.
		assert_eq!(pcm[2], (0.125 / 0.5 * LEVEL * f32::from(i16::MAX)) as i16);
		assert!(to_opus_pcm(&[f32::NAN, 0.0], 24_000).iter().all(|sample| *sample == 0));
	}

	#[test]
	fn the_silence_around_a_phrase_is_trimmed_to_a_margin() {
		// Half a second of silence, a tenth of a second of speech, half a
		// second of silence, at 24 kHz.
		let mut samples = vec![0.0; 12_000];
		samples.extend(vec![0.5; 2_400]);
		samples.extend(vec![0.0; 12_000]);
		let pcm = to_opus_pcm(&samples, 24_000);
		let seconds = pcm.len() as f64 / 2.0 / f64::from(OPUS_RATE);
		let expected = 0.1 + 2.0 * MARGIN_MS as f64 / 1000.0;
		assert!((seconds - expected).abs() < 0.001, "{seconds}s");
	}

	#[test]
	fn file_names_do_not_change_between_builds() {
		assert_eq!(file_name("Skipping.", Voice::English), "en-5de199f70891bbbc.pcm");
	}

	#[test]
	fn languages_are_the_bots_codes() {
		for (code, voice) in [
			("en", Voice::English),
			("ja", Voice::Japanese),
			("ko", Voice::Korean),
			("zh", Voice::Mandarin),
			("yue", Voice::Cantonese),
		] {
			assert_eq!(Voice::for_language(Some(code)), voice);
			assert_eq!(voice.name(), code);
		}
		assert_eq!(Voice::for_language(Some("fr")), Voice::English);
		assert_eq!(Voice::for_language(None), Voice::English);
	}
}
