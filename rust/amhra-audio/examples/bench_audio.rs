//! Demux and seek benchmarks, reported as JSON for the harness in `bench/`.
//!
//! ```text
//! cargo run --release -p amhra-audio --example bench -- <file.music>
//! ```
//!
//! Every measurement is a median over repeated runs rather than a mean: one
//! descheduled run would otherwise move the answer, and the thing being
//! compared is what usually happens, not the worst case.

use std::path::Path;
use std::time::Instant;

use amhra_audio::{CacheReader, WebmDemuxer};

fn median(mut samples: Vec<f64>) -> f64 {
	samples.sort_by(|a, b| a.partial_cmp(b).expect("no NaN timings"));
	samples[samples.len() / 2]
}

fn percentile(mut samples: Vec<f64>, fraction: f64) -> f64 {
	samples.sort_by(|a, b| a.partial_cmp(b).expect("no NaN timings"));
	let index = ((samples.len() as f64 - 1.0) * fraction).round() as usize;
	samples[index]
}

/// Run `body` `runs` times, returning median and p95 in milliseconds.
fn measure(runs: usize, mut body: impl FnMut()) -> (f64, f64) {
	// One untimed pass so the file is in the page cache and the branch
	// predictors have seen the shape of the work.
	body();
	let mut samples = Vec::with_capacity(runs);
	for _ in 0..runs {
		let started = Instant::now();
		body();
		samples.push(started.elapsed().as_secs_f64() * 1000.0);
	}
	(median(samples.clone()), percentile(samples, 0.95))
}

fn main() {
	let path = std::env::args().nth(1).expect("usage: bench <file.music>");
	let bytes = std::fs::read(&path).expect("readable cache file");
	let megabytes = bytes.len() as f64 / (1024.0 * 1024.0);

	// Demux the whole file, counting frames. This is what the downloader does
	// while writing, and what the reader does when a track is opened.
	let mut frames = 0u64;
	let (demux_ms, demux_p95) = measure(20, || {
		let mut demuxer = WebmDemuxer::new();
		let mut count = 0u64;
		demuxer.feed(&bytes, &mut |_| count += 1).expect("valid webm");
		frames = std::hint::black_box(count);
	});

	// The same work split into network-sized chunks, which is the shape the
	// downloader actually feeds it.
	let (chunked_ms, chunked_p95) = measure(20, || {
		let mut demuxer = WebmDemuxer::new();
		let mut count = 0u64;
		for chunk in bytes.chunks(256 * 1024) {
			demuxer.feed(chunk, &mut |_| count += 1).expect("valid webm");
		}
		// Observed, or the optimiser is free to delete the work: the sink's
		// only effect is a local increment nothing reads.
		assert_eq!(std::hint::black_box(count), frames);
	});

	// Opening a track: map, demux, ready to play.
	let (open_ms, open_p95) = measure(20, || {
		let reader = CacheReader::open_path(Path::new(&path), None).expect("opens");
		std::hint::black_box(reader.frame_count());
	});

	// Seeking within an open track, averaged over the whole file.
	let mut reader = CacheReader::open_path(Path::new(&path), None).expect("opens");
	let duration = reader.buffered_ms().max(1);
	let mut target = 0u32;
	let (seek_ms, seek_p95) = measure(2_000, || {
		target = (target + 7_919) % duration;
		std::hint::black_box(reader.seek(target));
	});

	println!(
		r#"{{"stack":"rust","file":{:?},"bytes":{},"frames":{},"results":[{}]}}"#,
		path,
		bytes.len(),
		frames,
		[
			result("demux_whole_file", demux_ms, demux_p95, Some(megabytes / (demux_ms / 1000.0))),
			result(
				"demux_256k_chunks",
				chunked_ms,
				chunked_p95,
				Some(megabytes / (chunked_ms / 1000.0))
			),
			result("open_track", open_ms, open_p95, None),
			micros("seek", seek_ms, seek_p95),
		]
		.join(",")
	);
}

/// A measurement small enough that milliseconds would round to zero.
fn micros(name: &str, median_ms: f64, p95_ms: f64) -> String {
	format!(
		r#"{{"name":"{name}","medianMs":{median_ms:.6},"p95Ms":{p95_ms:.6},"usPerFrame":{:.3}}}"#,
		median_ms * 1000.0
	)
}

fn result(name: &str, median_ms: f64, p95_ms: f64, throughput: Option<f64>) -> String {
	match throughput {
		Some(mibs) => format!(
			r#"{{"name":"{name}","medianMs":{median_ms:.4},"p95Ms":{p95_ms:.4},"mibPerSec":{mibs:.1}}}"#
		),
		None => format!(r#"{{"name":"{name}","medianMs":{median_ms:.4},"p95Ms":{p95_ms:.4}}}"#),
	}
}
