//! Run the voice-command pipeline over WAV files, with no Discord involved.
//!
//! ```text
//! cargo run --release -p amhra-sidecar --features voice-commands --example wake_wav -- \
//!     recordings/*.wav
//! ```
//!
//! Each file is one speaker, 16 kHz mono — what `record_users` writes. It is
//! fed through the same gate the sidecar runs, 20ms at a time, followed by
//! `--tail-ms` of silence so a command at the very end still closes. Every
//! wake, timeout and transcript is printed with its position in the file.
//!
//! For tuning: `--threshold` and `--boost` override the keyword defaults
//! without editing the keywords file, `--keywords` points at another list, and
//! `--preroll-ms` moves the start of the window, `--wait-for-speech-ms`,
//! `--end-silence-ms` and `--max-capture-ms` its other timings, and `--recogniser-threads` sets
//! how many threads speech recognition gets, `--provider cpu|coreml` where it
//! runs (coreml needs `--features shared-onnxruntime`), `--language <lang>`
//! pins what it listens for. `--wake-model <dir>` tries a
//! fine-tuned spotter from `training/wake/export.sh`.
//! `--spell` prints the keywords as the spotter will read them, word pieces and
//! all, and exits.
//! `--whole` also transcribes each file entire, ungated, for comparison.
//! `--dump <dir>` writes every captured window out as a WAV, to hear exactly
//! what the recogniser was given. The last line is the throughput: how much of one core the spotter and VAD
//! needed per speaker, and how long recognition took per command.
//!
//! `record_users` drops the quiet between bursts, as Discord does not send it,
//! which runs a pause after a command straight into whatever came next. Record
//! with `--keep-gaps` for files whose silences are where they were.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use amhra_sidecar::voice_commands;
use amhra_sidecar::voice_commands::gate::{Gate, GateConfig, GateEvent};
use amhra_sidecar::voice_commands::sherpa::{self, SherpaConfig};
use amhra_sidecar::voice_commands::{
	Detection, FRAME_SAMPLES, ModelError, Models, SAMPLE_RATE, Spotter, Transcriber, Vad, milliseconds,
};

struct Args {
	models: PathBuf,
	keywords: PathBuf,
	threshold: Option<f32>,
	boost: Option<f32>,
	threads: Option<i32>,
	provider: Option<String>,
	language: Option<String>,
	spotter: Option<PathBuf>,
	tail_ms: u32,
	verbose: bool,
	spell: bool,
	dump: Option<PathBuf>,
	whole: bool,
	gate: GateConfig,
	files: Vec<PathBuf>,
}

fn args() -> Args {
	let mut args = Args {
		models: PathBuf::from("models/voice"),
		keywords: PathBuf::from("data/wake-keywords.txt"),
		threshold: None,
		boost: None,
		threads: None,
		provider: None,
		language: None,
		spotter: None,
		tail_ms: 1500,
		verbose: false,
		spell: false,
		dump: None,
		whole: false,
		gate: GateConfig::default(),
		files: Vec::new(),
	};
	let mut argv = std::env::args().skip(1);
	while let Some(arg) = argv.next() {
		let mut value = || argv.next().expect("option needs a value");
		match arg.as_str() {
			"--models" => args.models = value().into(),
			"--keywords" => args.keywords = value().into(),
			"--threshold" => args.threshold = Some(value().parse().expect("--threshold takes a number")),
			"--boost" => args.boost = Some(value().parse().expect("--boost takes a number")),
			"--recogniser-threads" => args.threads = Some(value().parse().expect("--recogniser-threads takes a number")),
			"--wake-model" => args.spotter = Some(value().into()),
			"--provider" => args.provider = Some(value()),
			"--language" => args.language = Some(value()),
			"--tail-ms" => args.tail_ms = value().parse().expect("--tail-ms takes a number"),
			"--verbose" => args.verbose = true,
			"--spell" => args.spell = true,
			"--dump" => args.dump = Some(value().into()),
			"--whole" => args.whole = true,
			"--preroll-ms" => args.gate.preroll_ms = value().parse().expect("--preroll-ms takes a number"),
			"--wait-for-speech-ms" => {
				args.gate.wait_for_speech_ms = value().parse().expect("--wait-for-speech-ms takes a number");
			}
			"--end-silence-ms" => args.gate.end_silence_ms = value().parse().expect("--end-silence-ms takes a number"),
			"--max-capture-ms" => args.gate.max_capture_ms = value().parse().expect("--max-capture-ms takes a number"),
			other if other.starts_with("--") => panic!("unknown option {other}"),
			file => args.files.push(file.into()),
		}
	}
	assert!(args.spell || !args.files.is_empty(), "name at least one WAV file");
	args
}

/// Seconds into the file, for printing.
fn at(position: usize) -> f64 {
	position as f64 / f64::from(SAMPLE_RATE)
}

/// Prints every raw detection with where the spotter placed the keyword's end.
struct Loud {
	inner: Box<dyn Spotter>,
	position: Arc<std::sync::atomic::AtomicUsize>,
}

impl Spotter for Loud {
	fn accept(&mut self, samples: &[f32]) -> Option<Detection> {
		let detection = self.inner.accept(samples);
		if let Some(Detection { keyword, lag }) = &detection {
			let now = self.position.load(std::sync::atomic::Ordering::Relaxed) + samples.len();
			println!(
				"    spotter: {keyword} fired at {:.2}s, says it ended at {:.2}s ({}ms lag)",
				at(now),
				at(now.saturating_sub(*lag)),
				milliseconds(*lag),
			);
		}
		detection
	}

	fn reset(&mut self) {
		self.inner.reset();
	}
}

struct LoudModels {
	inner: Arc<dyn Models>,
	position: Arc<std::sync::atomic::AtomicUsize>,
}

impl Models for LoudModels {
	fn spotter(&self) -> Result<Box<dyn Spotter>, ModelError> {
		Ok(Box::new(Loud { inner: self.inner.spotter()?, position: Arc::clone(&self.position) }))
	}

	fn vad(&self) -> Result<Box<dyn Vad>, ModelError> {
		self.inner.vad()
	}
}

fn main() {
	let args = args();
	let keywords = std::fs::read_to_string(&args.keywords)
		.unwrap_or_else(|error| panic!("{}: {error}", args.keywords.display()));
	let mut config = SherpaConfig::new(args.models.clone(), keywords);
	if let Some(threshold) = args.threshold {
		config.keyword_threshold = threshold;
	}
	if let Some(boost) = args.boost {
		config.keyword_boost = boost;
	}
	if let Some(threads) = args.threads {
		config.recogniser_threads = threads;
	}
	if let Some(name) = &args.provider {
		let provider = sherpa::Provider::parse(name).unwrap_or_else(|| panic!("unknown provider {name}"));
		assert!(provider.available(), "{name} is not in this build; add --features shared-onnxruntime");
		config.recogniser_provider = provider;
	}
	if let Some(language) = &args.language {
		config.recogniser_language = language.clone();
	}
	config.spotter = args.spotter.clone();

	if args.spell {
		let kws = sherpa::ModelPaths::of(&config);
		let read = |path: &std::path::Path| std::fs::read(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
		let vocabulary = voice_commands::keywords::Vocabulary::from_sentencepiece(&read(&kws.kws_bpe)).unwrap();
		let tokens = voice_commands::keywords::token_set(&String::from_utf8_lossy(&read(&kws.kws_tokens)));
		let keywords = voice_commands::keywords::parse(&config.keywords).unwrap_or_else(|error| panic!("{error}"));
		match voice_commands::keywords::spotter_lines(&keywords, &vocabulary, &tokens, config.keyword_boost, config.keyword_threshold) {
			Ok(lines) => print!("{lines}"),
			Err(error) => println!("{error}"),
		}
		return;
	}

	let loading = Instant::now();
	let (models, mut recogniser) = sherpa::load(&config).unwrap_or_else(|error| panic!("{error}"));
	println!("models loaded in {:?}", loading.elapsed());
	let position = Arc::new(std::sync::atomic::AtomicUsize::new(0));
	let models: Arc<dyn Models> = if args.verbose {
		Arc::new(LoudModels { inner: models, position: Arc::clone(&position) })
	} else {
		models
	};

	let mut audio_total = Duration::ZERO;
	let mut gating_total = Duration::ZERO;
	let mut recognitions = Vec::new();
	let (mut wakes, mut commands, mut timeouts) = (0, 0, 0);

	for file in &args.files {
		let wave = sherpa_onnx::Wave::read(&file.to_string_lossy())
			.unwrap_or_else(|| panic!("{}: not a readable WAV file", file.display()));
		assert_eq!(
			wave.sample_rate(),
			SAMPLE_RATE as i32,
			"{}: must be {SAMPLE_RATE} Hz mono",
			file.display()
		);
		let mut samples = wave.samples().to_vec();
		samples.extend(std::iter::repeat_n(0.0, voice_commands::samples(args.tail_ms)));
		println!("{} ({:.1}s)", file.display(), at(wave.samples().len()));
		if args.whole {
			match recogniser.transcribe(wave.samples()) {
				Ok(transcript) => println!("  whole file: [{}] {:?}", transcript.lang.as_deref().unwrap_or("?"), transcript.text),
				Err(error) => println!("  whole file: {error}"),
			}
		}

		let mut gate =
			Gate::new(args.gate, models.spotter().unwrap(), models.vad().unwrap());
		let mut events = Vec::new();
		let started = Instant::now();
		for (index, frame) in samples.chunks(FRAME_SAMPLES).enumerate() {
			let offset = index * FRAME_SAMPLES;
			position.store(offset, std::sync::atomic::Ordering::Relaxed);
			gate.push(frame, &mut |event| events.push((offset + frame.len(), event)));
		}
		gating_total += started.elapsed();
		audio_total += Duration::from_secs_f64(at(samples.len()));

		for (position, event) in events {
			match event {
				GateEvent::Woke { keyword } => {
					wakes += 1;
					println!("  {:6.2}s  woke on {keyword}", at(position));
				}
				GateEvent::TimedOut { keyword } => {
					timeouts += 1;
					println!("  {:6.2}s  {keyword}, then nothing", at(position));
				}
				// Not asked for: the gate here never saves the name.
				GateEvent::Name { .. } => {}
				GateEvent::Captured(capture) => {
					commands += 1;
					if let Some(dir) = &args.dump {
						std::fs::create_dir_all(dir).expect("dump directory");
						let name = file.file_stem().unwrap_or_default().to_string_lossy();
						let path = dir.join(format!("{name}-{:.2}s.wav", at(position)));
						sherpa_onnx::write(&path.to_string_lossy(), &capture.samples, SAMPLE_RATE as i32);
					}
					let started = Instant::now();
					let transcript = recogniser.transcribe(&capture.samples);
					let took = started.elapsed();
					recognitions.push(took);
					let ended = position - capture.since_speech;
					match transcript {
						Ok(transcript) => println!(
							"  {:6.2}s  [{}] {:?} (heard {:?})  ({:.1}s window{}, speech ended {:.2}s, text {}ms after that: {}ms silence + {}ms recognition)",
							at(position),
							transcript.lang.as_deref().unwrap_or("?"),
							// What the sidecar reports: the name's tail cut off.
							voice_commands::trim::after_name(
								&transcript.text,
								&transcript.tokens,
								at(capture.name_end) as f32,
							),
							transcript.text,
							at(capture.samples.len()),
							if capture.capped { ", capped" } else { "" },
							at(ended),
							milliseconds(capture.since_speech) + took.as_millis() as u32,
							milliseconds(capture.since_speech),
							took.as_millis(),
						),
						Err(error) => println!("  {:6.2}s  recognition failed: {error}", at(position)),
					}
				}
			}
		}
	}

	let core = gating_total.as_secs_f64() / audio_total.as_secs_f64();
	println!(
		"\n{} file(s), {:.1}s of audio: {wakes} wake(s), {commands} command(s), {timeouts} timeout(s)",
		args.files.len(),
		audio_total.as_secs_f64()
	);
	println!(
		"spotter + VAD: {:.2}% of one core per speaker ({:.1}x real time)",
		core * 100.0,
		1.0 / core
	);
	if !recognitions.is_empty() {
		recognitions.sort();
		let mean = recognitions.iter().sum::<Duration>() / recognitions.len() as u32;
		println!(
			"recognition: mean {}ms, max {}ms over {} command(s)",
			mean.as_millis(),
			recognitions.last().unwrap().as_millis(),
			recognitions.len()
		);
	}
}
