//! The bot saying what it is doing: "Skipping.", "Paused.", over the music.
//!
//! Built for a small computer, a Raspberry Pi class board. The model (Kokoro:
//! 330 MB of weights, 700 MB once loaded, seconds of CPU for every phrase on
//! such a board) is too heavy to run each time something is said, and most of
//! what the bot says is the same few dozen phrases. Those the bot names with
//! `prepare` are synthesised once, ahead of time, saved under the cache
//! directory, and from then on only read back. The rest ("Playing bad guy.")
//! is synthesised when it is said and remembered for a while, but not saved,
//! so the store stays the size of the fixed phrases. The model is loaded only
//! to say something new, and let go after a minute of nothing new.
//!
//! One thread does all of it, so at most one core is ever busy with speech.
//! What is to be said now goes before what is being prepared, and is given up
//! if it could not be said soon enough to still make sense.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::time::{Duration, Instant};

/// The rate and layout the worker mixes in: interleaved stereo at 48 kHz.
const OPUS_RATE: u32 = 48_000;

/// Peak level, as a fraction of full scale. The music is lowered under it.
const LEVEL: f32 = 0.4;

/// How long the model stays loaded with nothing new to say.
const IDLE: Duration = Duration::from_secs(60);

/// Asked longer ago than this, a phrase is saved but not said: "Skipping"
/// several seconds after the skip is noise.
const STALE: Duration = Duration::from_secs(8);

/// Phrases kept in memory, about 200 KB a second of speech each.
const REMEMBERED: usize = 64;

/// Which of the model's voices says it. The model reads English and Chinese;
/// anything else is answered in English by the bot, so it is said in English.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Voice {
	English,
	Chinese,
}

impl Voice {
	/// The voice for a language code as the bot sends it.
	pub fn for_language(language: Option<&str>) -> Self {
		match language {
			Some("zh" | "yue") => Self::Chinese,
			_ => Self::English,
		}
	}

	fn name(self) -> &'static str {
		match self {
			Self::English => "en",
			Self::Chinese => "zh",
		}
	}
}

/// Text to speech.
pub trait Synthesiser {
	/// `text` said in `voice`: mono samples in -1..1, and their rate.
	fn speak(&mut self, text: &str, voice: Voice) -> Result<(Vec<f32>, u32), String>;
}

/// Loads the model. Called on the speech thread, each time it is needed after
/// having been let go.
pub type Load = Box<dyn FnMut() -> Result<Box<dyn Synthesiser>, String> + Send>;

/// Hands a guild's worker what to play.
pub type Deliver = Box<dyn Fn(&str, Arc<[i16]>) + Send>;

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
	pub fn start(load: Load, store: Option<PathBuf>, deliver: Deliver) -> std::io::Result<Self> {
		let (requests, inbox) = std::sync::mpsc::channel();
		if let Some(store) = &store {
			std::fs::create_dir_all(store)?;
		}
		std::thread::Builder::new().name("speech".to_owned()).spawn(move || run(&inbox, load, store, &deliver))?;
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

fn run(inbox: &Receiver<Request>, mut load: Load, store: Option<PathBuf>, deliver: &Deliver) {
	let mut model: Option<Box<dyn Synthesiser>> = None;
	let mut remembered: HashMap<(Voice, String), Arc<[i16]>> = HashMap::new();
	let mut saying = VecDeque::new();
	let mut preparing = VecDeque::new();
	let mut failed = false;
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
			match inbox.recv_timeout(if model.is_some() { IDLE } else { Duration::MAX }) {
				Ok(request @ Request::Say { .. }) => saying.push_back(request),
				Ok(request @ Request::Prepare { .. }) => preparing.push_back(request),
				Err(RecvTimeoutError::Timeout) => {
					eprintln!("speech: letting the model go");
					model = None;
				}
				Err(RecvTimeoutError::Disconnected) => return,
			}
			continue;
		};
		let (text, voice) = match &request {
			Request::Say { text, voice, .. } | Request::Prepare { text, voice } => (text.clone(), *voice),
		};
		let prepared = matches!(request, Request::Prepare { .. });
		let path = store.as_ref().map(|store| store.join(file_name(&text, voice)));
		let key = (voice, text);
		let known = remembered.get(&key).cloned().or_else(|| path.as_deref().and_then(read));
		let saved = known.is_some() && path.as_ref().is_some_and(|path| path.is_file());
		let pcm = known.or_else(|| {
			let started = Instant::now();
			let pcm = synthesise(&mut model, &mut load, &mut failed, &key.1, voice)?;
			eprintln!("speech: synthesised {} chars in {:?}", key.1.chars().count(), started.elapsed());
			Some(pcm)
		});
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

/// The model's rendering of `text`, loading it first if it was let go. A
/// model that will not load is said once, not on every phrase.
fn synthesise(
	model: &mut Option<Box<dyn Synthesiser>>,
	load: &mut Load,
	failed: &mut bool,
	text: &str,
	voice: Voice,
) -> Option<Arc<[i16]>> {
	if model.is_none() {
		let started = Instant::now();
		match load() {
			Ok(loaded) => {
				eprintln!("speech: model loaded in {:?}", started.elapsed());
				*model = Some(loaded);
				*failed = false;
			}
			Err(error) => {
				if !*failed {
					eprintln!("speech: cannot load the model: {error}");
				}
				*failed = true;
				return None;
			}
		}
	}
	match model.as_mut()?.speak(text, voice) {
		Ok((samples, rate)) => Some(to_opus_pcm(&samples, rate).into()),
		Err(error) => {
			eprintln!("speech: could not say a phrase: {error}");
			None
		}
	}
}

/// Mono samples at `rate` as the worker plays them: interleaved stereo at the
/// Opus rate, peaking at `LEVEL`. Linear interpolation is plenty for speech
/// going up from 24 kHz.
pub fn to_opus_pcm(samples: &[f32], rate: u32) -> Vec<i16> {
	let peak = samples.iter().filter(|sample| sample.is_finite()).fold(0f32, |peak, sample| peak.max(sample.abs()));
	if samples.is_empty() || rate == 0 || peak == 0.0 {
		return Vec::new();
	}
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

/// Kokoro, through sherpa-onnx.
#[cfg(feature = "voice-commands")]
pub mod kokoro {
	use super::{Load, Synthesiser, Voice};
	use sherpa_onnx::{
		GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig, OfflineTtsModelConfig,
	};

	/// `kokoro-multi-lang-v1_0`, unpacked in `dir`, on `threads` CPU threads.
	/// The fp32 one: the int8 one only says NaN on Apple silicon.
	pub fn config(dir: &str, threads: i32, provider: &str, lang: Option<String>) -> OfflineTtsConfig {
		let file = |name: &str| Some(format!("{dir}/{name}"));
		OfflineTtsConfig {
			model: OfflineTtsModelConfig {
				vits: Default::default(),
				matcha: Default::default(),
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
				kitten: Default::default(),
				zipvoice: Default::default(),
				pocket: Default::default(),
				supertonic: Default::default(),
				num_threads: threads,
				debug: false,
				provider: Some(provider.to_owned()),
			},
			rule_fsts: Some(format!("{dir}/date-zh.fst,{dir}/phone-zh.fst,{dir}/number-zh.fst")),
			max_num_sentences: 1,
			..OfflineTtsConfig::default()
		}
	}

	struct Kokoro(OfflineTts);

	impl Synthesiser for Kokoro {
		fn speak(&mut self, text: &str, voice: Voice) -> Result<(Vec<f32>, u32), String> {
			// af_heart and zf_xiaoxiao.
			let sid = match voice {
				Voice::English => 3,
				Voice::Chinese => 47,
			};
			let generation = GenerationConfig { sid, ..GenerationConfig::default() };
			let audio = self
				.0
				.generate_with_config(text, &generation, None::<fn(&[f32], f32) -> bool>)
				.ok_or("the model said nothing")?;
			Ok((audio.samples().to_vec(), audio.sample_rate() as u32))
		}
	}

	/// Loads Kokoro from `dir` when called, on the CPU.
	pub fn load(dir: String, threads: i32) -> Load {
		Box::new(move || {
			if !std::path::Path::new(&dir).join("model.onnx").is_file() {
				return Err(format!("no Kokoro model in {dir}"));
			}
			OfflineTts::create(&config(&dir, threads, "cpu", None))
				.map(|tts| Box::new(Kokoro(tts)) as Box<dyn Synthesiser>)
				.ok_or_else(|| format!("sherpa-onnx would not load {dir}"))
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::sync::Mutex;
	use std::sync::atomic::{AtomicUsize, Ordering};

	/// Says a tone as long as the text, counting how often it was asked and
	/// loaded.
	struct Fake(Arc<AtomicUsize>);

	impl Synthesiser for Fake {
		fn speak(&mut self, text: &str, _: Voice) -> Result<(Vec<f32>, u32), String> {
			self.0.fetch_add(1, Ordering::SeqCst);
			Ok((vec![0.5; text.len() * 240], 24_000))
		}
	}

	fn fake(spoken: &Arc<AtomicUsize>, loads: &Arc<AtomicUsize>) -> Load {
		let (spoken, loads) = (Arc::clone(spoken), Arc::clone(loads));
		Box::new(move || {
			loads.fetch_add(1, Ordering::SeqCst);
			Ok(Box::new(Fake(Arc::clone(&spoken))) as Box<dyn Synthesiser>)
		})
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
		let (spoken, loads) = (Arc::default(), Arc::default());

		let (heard, deliver) = listener();
		let speech = Speech::start(fake(&spoken, &loads), Some(store.clone()), deliver).unwrap();
		speech.prepare("Paused.".into(), Voice::English);
		speech.prepare("Skipping.".into(), Voice::English);
		speech.say("g".into(), "Skipping.".into(), Voice::English);
		speech.say("g".into(), "Skipping.".into(), Voice::English);
		speech.say("g".into(), "Playing bad guy.".into(), Voice::English);
		speech.say("g".into(), "Playing bad guy.".into(), Voice::English);
		settle(&heard, 4);
		assert_eq!(spoken.load(Ordering::SeqCst), 3, "each phrase once");
		// 9 characters, 2160 samples at 24 kHz, are 4320 at 48 kHz, twice over.
		assert_eq!(heard.lock().unwrap()[0], ("g".to_owned(), 8640));
		assert_eq!(heard.lock().unwrap().len(), 4);
		std::thread::sleep(Duration::from_millis(50));
		assert_eq!(std::fs::read_dir(&store).unwrap().count(), 2, "only the prepared phrases are saved");
		drop(speech);

		// After a restart, the prepared ones are read back without the model.
		let (spoken, loads) = (Arc::default(), Arc::default());
		let (heard, deliver) = listener();
		let speech = Speech::start(fake(&spoken, &loads), Some(store.clone()), deliver).unwrap();
		speech.say("g".into(), "Skipping.".into(), Voice::English);
		speech.say("g".into(), "Paused.".into(), Voice::English);
		settle(&heard, 2);
		assert_eq!(heard.lock().unwrap().len(), 2);
		assert_eq!(loads.load(Ordering::SeqCst), 0);
		// The rest is synthesised again, and another voice is another phrase.
		speech.say("g".into(), "Playing bad guy.".into(), Voice::English);
		speech.say("g".into(), "Skipping.".into(), Voice::Chinese);
		settle(&heard, 4);
		assert_eq!(spoken.load(Ordering::SeqCst), 2);
		drop(speech);
		let _ = std::fs::remove_dir_all(&store);
	}

	#[test]
	fn a_model_that_will_not_load_says_nothing() {
		let (heard, deliver) = listener();
		let speech = Speech::start(Box::new(|| Err("missing".into())), None, deliver).unwrap();
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
	fn file_names_do_not_change_between_builds() {
		assert_eq!(file_name("Skipping.", Voice::English), "en-5de199f70891bbbc.pcm");
	}
}
