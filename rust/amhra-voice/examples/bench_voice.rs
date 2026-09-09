//! Voice-path benchmarks: transport encryption, DAVE framing, and volume.
//!
//! ```text
//! cargo run --release -p amhra-voice --example bench -- <file.music>
//! ```
//!
//! These are the per-frame costs — whatever they are, they are paid fifty times
//! a second for every guild — so they are measured per frame and reported in
//! microseconds, alongside how much of a 20ms budget one stream consumes.

use std::time::Instant;

use amhra_audio::WebmDemuxer;
use amhra_voice::dave::frame::Encryptor;
use amhra_voice::dsp::Volume;
use amhra_voice::wire::EncryptionMode;
use amhra_voice::{Session, crypto};

const KEY: [u8; 32] = [7u8; 32];

fn median(mut samples: Vec<f64>) -> f64 {
	samples.sort_by(|a, b| a.partial_cmp(b).expect("no NaN timings"));
	samples[samples.len() / 2]
}

/// Time `body` over `frames` iterations, returning microseconds per frame.
fn per_frame(runs: usize, frames: usize, mut body: impl FnMut()) -> f64 {
	for _ in 0..frames {
		body();
	}
	let mut samples = Vec::with_capacity(runs);
	for _ in 0..runs {
		let started = Instant::now();
		for _ in 0..frames {
			body();
		}
		samples.push(started.elapsed().as_secs_f64() * 1e6 / frames as f64);
	}
	median(samples)
}

fn main() {
	let path = std::env::args().nth(1).expect("usage: bench <file.music>");
	let bytes = std::fs::read(&path).expect("readable cache file");

	// Real Opus frames, so the codec sees what it will see in production.
	let mut demuxer = WebmDemuxer::new();
	let mut frames: Vec<Vec<u8>> = Vec::new();
	demuxer
		.feed(&bytes, &mut |frame| {
			let start = frame.offset as usize;
			frames.push(bytes[start..start + frame.len as usize].to_vec());
		})
		.expect("valid webm");
	assert!(!frames.is_empty(), "no Opus frames in {path}");

	let mut cursor = 0usize;
	let mut next = || {
		cursor = (cursor + 1) % frames.len();
		&frames[cursor]
	};

	// Transport encryption: RTP header, AEAD, nonce. Every frame pays this.
	let mut aes = Session::with_start(EncryptionMode::AeadAes256GcmRtpSize, &KEY, 1, 0, 0)
		.expect("session");
	let mut packet = Vec::with_capacity(1400);
	let aes_us = per_frame(10, 5_000, || {
		let frame = next();
		aes.seal(frame, &mut packet).expect("seal");
		// The nonce is 32 bits, and 50 frames a second exhausts it in about
		// two years; a benchmark reaches it in seconds.
		if aes.sequence().is_multiple_of(30_000) {
			aes = Session::with_start(EncryptionMode::AeadAes256GcmRtpSize, &KEY, 1, 0, 0)
				.expect("session");
		}
	});

	let mut chacha =
		Session::with_start(EncryptionMode::AeadXChaCha20Poly1305RtpSize, &KEY, 1, 0, 0)
			.expect("session");
	let chacha_us = per_frame(10, 5_000, || {
		let frame = next();
		chacha.seal(frame, &mut packet).expect("seal");
		if chacha.sequence().is_multiple_of(30_000) {
			chacha =
				Session::with_start(EncryptionMode::AeadXChaCha20Poly1305RtpSize, &KEY, 1, 0, 0)
					.expect("session");
		}
	});

	// DAVE end-to-end framing, which sits inside the transport encryption.
	let mut dave = Encryptor::new(vec![9u8; 16]);
	let mut e2ee = Vec::with_capacity(1400);
	let dave_us = per_frame(10, 5_000, || {
		let frame = next();
		dave.encrypt_opus(frame, &mut e2ee).expect("dave");
	});

	// Volume at 100: the frame is handed straight through.
	let mut passthrough = Volume::new();
	let passthrough_us = per_frame(10, 5_000, || {
		let frame = next();
		std::hint::black_box(passthrough.process(frame).expect("passthrough"));
	});

	// Volume at anything else: decode, scale, re-encode.
	let mut scaled = Volume::new();
	scaled.set_gain(0.5);
	let scaled_us = per_frame(10, 2_000, || {
		let frame = next();
		std::hint::black_box(scaled.process(frame).expect("scale"));
	});

	// What the audio thread actually does per tick, at volume 100.
	let mut full = Volume::new();
	let mut full_dave = Encryptor::new(vec![3u8; 16]);
	let mut full_session =
		Session::with_start(EncryptionMode::AeadAes256GcmRtpSize, &KEY, 1, 0, 0).expect("session");
	let full_us = per_frame(10, 5_000, || {
		let frame = next();
		let scaled = full.process(frame).expect("gain");
		full_dave.encrypt_opus(scaled, &mut e2ee).expect("dave");
		full_session.seal(&e2ee, &mut packet).expect("seal");
		if full_session.sequence().is_multiple_of(30_000) {
			full_session =
				Session::with_start(EncryptionMode::AeadAes256GcmRtpSize, &KEY, 1, 0, 0)
					.expect("session");
		}
	});

	let results = [
		entry("transport_aes256_gcm", aes_us),
		entry("transport_xchacha20", chacha_us),
		entry("dave_frame", dave_us),
		entry("volume_passthrough", passthrough_us),
		entry("volume_scaled", scaled_us),
		entry("full_tick_volume_100", full_us),
	];

	println!(
		r#"{{"stack":"rust","file":{:?},"frames":{},"packetOverheadBytes":{},"results":[{}]}}"#,
		path,
		frames.len(),
		crypto::RTP_HEADER_LEN + crypto::TAG_LEN + crypto::NONCE_SUFFIX_LEN,
		results.join(",")
	);
}

/// A per-frame cost, with the share of one 20ms tick it uses.
fn entry(name: &str, micros: f64) -> String {
	let budget = micros / 20_000.0 * 100.0;
	format!(r#"{{"name":"{name}","usPerFrame":{micros:.3},"percentOfTick":{budget:.4}}}"#)
}
