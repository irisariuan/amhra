//! Speak sentences with the Kokoro model and time it, with no Discord involved.
//!
//! ```text
//! cargo run --release -p amhra-sidecar --features voice-commands --example tts_wav -- \
//!     --sid 3 --out spoken.wav "Skipping." "Playing Juno, by Sabrina Carpenter."
//! ```
//!
//! `--model <dir>` is the unpacked `kokoro-multi-lang-v1_0` (the default,
//! under models/voice; the int8 one only says NaN on Apple silicon), `--provider cpu|coreml` where it runs
//! (coreml needs `--features shared-onnxruntime`), `--threads <n>` how many
//! CPU threads it gets, `--sid <n>` the voice, `--repeat <n>` how many times
//! each sentence is spoken for timing. Each sentence's time is printed after
//! one untimed warm-up; run it under `/usr/bin/time -l` for the CPU it used.

use std::time::Instant;

use sherpa_onnx::{GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig, OfflineTtsModelConfig};

fn main() {
	let mut model = String::from("models/voice/kokoro-multi-lang-v1_0");
	let mut provider = String::from("cpu");
	let mut threads = 1;
	let mut sid = 3;
	let mut repeat = 3;
	let mut out = None;
	let mut lang = None;
	let mut sentences = Vec::new();
	let mut argv = std::env::args().skip(1);
	while let Some(arg) = argv.next() {
		let mut value = || argv.next().expect("option needs a value");
		match arg.as_str() {
			"--model" => model = value(),
			"--provider" => provider = value(),
			"--threads" => threads = value().parse().expect("--threads takes a number"),
			"--sid" => sid = value().parse().expect("--sid takes a number"),
			"--repeat" => repeat = value().parse().expect("--repeat takes a number"),
			"--lang" => lang = Some(value()),
			"--out" => out = Some(value()),
			other if other.starts_with("--") => panic!("unknown option {other}"),
			sentence => sentences.push(sentence.to_owned()),
		}
	}
	assert!(!sentences.is_empty(), "give at least one sentence");

	let file = |name: &str| Some(format!("{model}/{name}"));
	let config = OfflineTtsConfig {
		model: OfflineTtsModelConfig {
			kokoro: OfflineTtsKokoroModelConfig {
				model: file("model.onnx"),
				voices: file("voices.bin"),
				tokens: file("tokens.txt"),
				data_dir: file("espeak-ng-data"),
				dict_dir: file("dict"),
				lexicon: Some(format!("{model}/lexicon-us-en.txt,{model}/lexicon-zh.txt")),
				lang,
				..OfflineTtsKokoroModelConfig::default()
			},
			num_threads: threads,
			provider: Some(provider.clone()),
			..default_model()
		},
		rule_fsts: Some(format!("{model}/date-zh.fst,{model}/phone-zh.fst,{model}/number-zh.fst")),
		max_num_sentences: 1,
		..OfflineTtsConfig::default()
	};
	let loading = Instant::now();
	let tts = OfflineTts::create(&config).expect("could not load the model");
	println!("loaded in {:?} on {provider} with {threads} thread(s); {} voices", loading.elapsed(), tts.num_speakers());

	let generation = GenerationConfig { sid, ..GenerationConfig::default() };
	let mut spoken = Vec::new();
	let mut rate = 0;
	for sentence in &sentences {
		let audio = tts.generate_with_config(sentence, &generation, None::<fn(&[f32], f32) -> bool>);
		let audio = audio.expect("no audio");
		rate = audio.sample_rate();
		spoken.extend_from_slice(audio.samples());
		spoken.extend(std::iter::repeat_n(0.0, rate as usize / 4));
		let mut times = Vec::new();
		for _ in 0..repeat {
			let started = Instant::now();
			tts.generate_with_config(sentence, &generation, None::<fn(&[f32], f32) -> bool>);
			times.push(started.elapsed());
		}
		let seconds = audio.samples().len() as f64 / f64::from(rate);
		let peak = audio.samples().iter().fold(0f32, |peak, sample| peak.max(sample.abs()));
		let broken = audio.samples().iter().filter(|sample| !sample.is_finite()).count();
		if broken > 0 {
			println!("{sentence:?}: {broken} of {} samples are not numbers", audio.samples().len());
		}
		let mean = times.iter().map(|time| time.as_secs_f64()).sum::<f64>() / times.len().max(1) as f64;
		println!(
			"{sentence:?}: {seconds:.2}s of speech (peak {peak:.3}) in {:.0}ms ({:.2}x real time)",
			mean * 1000.0,
			mean / seconds
		);
	}
	if let Some(out) = out {
		sherpa_onnx::write(&out, &spoken, rate);
		println!("wrote {out}");
	}
}

fn default_model() -> OfflineTtsModelConfig {
	OfflineTtsModelConfig {
		vits: Default::default(),
		matcha: Default::default(),
		kokoro: OfflineTtsKokoroModelConfig::default(),
		kitten: Default::default(),
		zipvoice: Default::default(),
		pocket: Default::default(),
		supertonic: Default::default(),
		num_threads: 1,
		debug: false,
		provider: None,
	}
}
