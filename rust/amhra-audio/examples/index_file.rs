//! Index a `.music` cache file and report what the demuxer found.
//!
//! Run against the real cache to check the parser against files the bot has
//! actually played:
//!
//! ```text
//! cargo run --release --example index_file -- ../cache/<id>.music
//! ```

use std::io::Read;
use std::path::PathBuf;
use std::time::Instant;

use amhra_audio::{CacheIndexer, Index};

fn main() -> Result<(), Box<dyn std::error::Error>> {
	let Some(path) = std::env::args().nth(1).map(PathBuf::from) else {
		eprintln!("usage: index_file <path to .music>");
		std::process::exit(2);
	};
	// Second argument redirects the sidecar, so a bulk run over a live cache
	// can validate the parser without writing anything into it.
	let index_path =
		std::env::args().nth(2).map(PathBuf::from).unwrap_or_else(|| path.with_extension("idx"));

	let mut file = std::io::BufReader::new(std::fs::File::open(&path)?);
	let mut indexer = CacheIndexer::create(&index_path)?;
	// 256KiB is roughly what a network read hands over, so this exercises the
	// same resumable path the downloader will.
	let mut chunk = vec![0u8; 256 * 1024];
	let mut total = 0u64;

	let started = Instant::now();
	loop {
		let read = file.read(&mut chunk)?;
		if read == 0 {
			break;
		}
		indexer.feed(&chunk[..read])?;
		total += read as u64;
	}
	let summary = indexer.finish()?;
	let elapsed = started.elapsed();

	let index = Index::open(&index_path)?;
	let header = index.header();
	let throughput = total as f64 / elapsed.as_secs_f64() / (1 << 20) as f64;

	println!("file        {}", path.display());
	println!("bytes       {total}");
	println!("frames      {}", summary.frames);
	println!("duration    {:.1}s (declared {}ms)", summary.duration_ms as f64 / 1000.0, header.duration_ms);
	println!("channels    {}  pre-skip {}", header.channels, header.pre_skip);
	println!("index       {} entries, {} bytes", index.len(), std::fs::metadata(&index_path)?.len());
	println!("demux       {:?} ({throughput:.0} MiB/s)", elapsed);

	// Every second must resolve to an entry no later than itself.
	for second in (0..header.duration_ms).step_by(1_000) {
		let entry = index.seek(second).expect("index is not empty");
		assert!(entry.timestamp_ms <= second, "seek({second}) overshot to {entry:?}");
		assert!(
			second - entry.timestamp_ms <= header.interval_ms as u32,
			"seek({second}) landed {}ms early",
			second - entry.timestamp_ms
		);
	}
	println!("seek        ok across {} checkpoints", header.duration_ms / 1_000);
	Ok(())
}
