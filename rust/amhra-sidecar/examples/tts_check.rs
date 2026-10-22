//! Speak sentences with a speech model, time it, and hear them back through
//! SenseVoice, for comparing models in languages nobody here can judge by ear.
//!
//! ```text
//! cargo run --release -p amhra-sidecar --features voice-commands --example tts_check -- \
//!     --engine supertonic --model <dir> --lang ja --sid 0 phrases.txt
//! ```
//!
//! `--engine kokoro|supertonic|vits` and `--model <dir>` name the model, as
//! sherpa-onnx's releases unpack it; `--sid <n>` the voice; `--lang <code>` is
//! passed to Supertonic, which needs it, and printed for the rest;
//! `--threads <n>` (default 1) the synthesis threads. The phrases file has one
//! sentence a line. One JSON line is printed per sentence: what was asked, how
//! long the speech is, how long it took to make (after one untimed warm-up),
//! and what SenseVoice (`--voice-models`, default models/voice; language
//! detected, not pinned) heard. `--out <dir>` keeps the WAVs.

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use amhra_sidecar::speech::kokoro;
use amhra_sidecar::voice_commands::sherpa::{ModelPaths, Provider, SenseVoice};
use amhra_sidecar::voice_commands::{SAMPLE_RATE, Transcriber};
use sherpa_onnx::{
	GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsModelConfig, OfflineTtsSupertonicModelConfig,
	OfflineTtsVitsModelConfig,
};

fn main() {
	let mut engine = String::from("kokoro");
	let mut model = String::new();
	let mut sid = 0;
	let mut lang = String::from("en");
	let mut threads = 1;
	let mut voice_models = String::from("models/voice");
	let mut out = None;
	let mut phrases = None;
	let mut argv = std::env::args().skip(1);
	while let Some(arg) = argv.next() {
		let mut value = || argv.next().expect("option needs a value");
		match arg.as_str() {
			"--engine" => engine = value(),
			"--model" => model = value(),
			"--sid" => sid = value().parse().expect("--sid takes a number"),
			"--lang" => lang = value(),
			"--threads" => threads = value().parse().expect("--threads takes a number"),
			"--voice-models" => voice_models = value(),
			"--out" => out = Some(value()),
			other if other.starts_with("--") => panic!("unknown option {other}"),
			file => phrases = Some(file.to_owned()),
		}
	}
	let phrases = std::fs::read_to_string(phrases.expect("give a phrases file")).expect("cannot read the phrases");
	let phrases: Vec<&str> = phrases.lines().map(str::trim).filter(|line| !line.is_empty()).collect();

	let config = match engine.as_str() {
		"kokoro" => kokoro::config(&model, threads, "cpu", None),
		"supertonic" => supertonic(&model, threads),
		"vits" => vits(&model, threads),
		other => panic!("unknown engine {other}"),
	};
	let loading = Instant::now();
	let tts = OfflineTts::create(&config).expect("could not load the model");
	let load_ms = loading.elapsed().as_millis();
	let mut generation = GenerationConfig { sid, ..GenerationConfig::default() };
	if engine == "supertonic" {
		generation.extra = Some(HashMap::from([("lang".to_owned(), serde_json::Value::from(lang.clone()))]));
	}
	let mut listener = SenseVoice::load(&ModelPaths::under(Path::new(&voice_models)), 4, Provider::Cpu, "auto")
		.expect("could not load SenseVoice");
	let speak = |text: &str| tts.generate_with_config(text, &generation, None::<fn(&[f32], f32) -> bool>);

	speak(phrases[0]);
	eprintln!("{engine} loaded in {load_ms}ms, {} voices, {} Hz", tts.num_speakers(), tts.sample_rate());
	if let Some(out) = &out {
		std::fs::create_dir_all(out).expect("cannot make the output directory");
	}
	for (index, text) in phrases.iter().enumerate() {
		let started = Instant::now();
		let audio = speak(text).expect("no audio");
		let synth_ms = started.elapsed().as_secs_f64() * 1000.0;
		let rate = audio.sample_rate();
		let samples = audio.samples();
		if let Some(out) = &out {
			sherpa_onnx::write(&format!("{out}/{engine}-{lang}-{sid}-{index:02}.wav"), samples, rate);
		}
		let heard = listener.transcribe(&resample(samples, rate as u32, SAMPLE_RATE)).expect("SenseVoice failed");
		let line = serde_json::json!({
			"engine": engine, "sid": sid, "lang": lang, "text": text,
			"speech_s": samples.len() as f64 / f64::from(rate),
			"synth_ms": synth_ms.round(),
			"broken": samples.iter().filter(|sample| !sample.is_finite()).count(),
			"heard": heard.text, "heard_lang": heard.lang,
		});
		println!("{line}");
	}
}

fn supertonic(dir: &str, threads: i32) -> OfflineTtsConfig {
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
			..cpu(threads)
		},
		max_num_sentences: 1,
		..OfflineTtsConfig::default()
	}
}

fn vits(dir: &str, threads: i32) -> OfflineTtsConfig {
	let file = |name: &str| Path::new(dir).join(name).is_file().then(|| format!("{dir}/{name}"));
	let fsts: Vec<String> = std::fs::read_dir(dir)
		.map(|entries| {
			entries
				.filter_map(|entry| entry.ok()?.file_name().into_string().ok())
				.filter(|name| name.ends_with(".fst"))
				.map(|name| format!("{dir}/{name}"))
				.collect()
		})
		.unwrap_or_default();
	let model = std::fs::read_dir(dir)
		.expect("cannot read the model directory")
		.filter_map(|entry| entry.ok()?.file_name().into_string().ok())
		.find(|name| name.ends_with(".onnx"))
		.expect("no .onnx in the model directory");
	OfflineTtsConfig {
		model: OfflineTtsModelConfig {
			vits: OfflineTtsVitsModelConfig {
				model: Some(format!("{dir}/{model}")),
				lexicon: file("lexicon.txt"),
				tokens: file("tokens.txt"),
				data_dir: file("espeak-ng-data"),
				dict_dir: file("dict"),
				..OfflineTtsVitsModelConfig::default()
			},
			..cpu(threads)
		},
		rule_fsts: (!fsts.is_empty()).then(|| fsts.join(",")),
		max_num_sentences: 1,
		..OfflineTtsConfig::default()
	}
}

fn cpu(threads: i32) -> OfflineTtsModelConfig {
	let mut config = kokoro::config("", threads, "cpu", None).model;
	config.kokoro = Default::default();
	config
}

/// To the recogniser's rate, by linear interpolation: enough to be heard.
fn resample(samples: &[f32], from: u32, to: u32) -> Vec<f32> {
	if samples.is_empty() || from == to {
		return samples.to_vec();
	}
	let length = (samples.len() as u64 * u64::from(to) / u64::from(from)) as usize;
	let step = f64::from(from) / f64::from(to);
	(0..length)
		.map(|index| {
			let at = index as f64 * step;
			let before = at.floor() as usize;
			let after = (before + 1).min(samples.len() - 1);
			let between = (at - before as f64) as f32;
			let value = samples[before] * (1.0 - between) + samples[after] * between;
			if value.is_finite() { value } else { 0.0 }
		})
		.collect()
}
