//! Ranged, concurrent download straight into the cache.
//!
//! YouTube throttles an unranged GET to roughly playback speed — measured at
//! 32KB/s against 7MB/s for the same file requested as ranges. So the download
//! is always chunked, never a single stream, and the chunks are fetched several
//! at a time.
//!
//! Chunks are *consumed* in order even though they are *fetched* out of order:
//! `buffered` hands them back in sequence, which keeps the file on disk
//! contiguous at every instant and lets the demuxer index the bytes as they
//! land. A player following the live cache file therefore never sees a hole,
//! and memory in flight is capped at `concurrency * chunk_size`.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use amhra_audio::CacheIndexer;
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

use crate::format::AudioFormat;

#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
	#[error("http: {0}")]
	Http(#[from] reqwest::Error),
	#[error("i/o: {0}")]
	Io(#[from] std::io::Error),
	#[error("indexing: {0}")]
	Index(#[from] amhra_audio::Error),
	#[error("server refused range request for chunk at {offset} (status {status})")]
	NoRangeSupport { offset: u64, status: u16 },
	#[error("chunk at {offset} failed after {attempts} attempts: {source}")]
	ChunkFailed { offset: u64, attempts: u32, source: reqwest::Error },
	#[error("download produced no bytes")]
	Empty,
}

#[derive(Debug, Clone, Copy)]
pub struct DownloadOptions {
	pub chunk_size: u64,
	pub concurrency: usize,
	pub attempts: u32,
}

impl Default for DownloadOptions {
	fn default() -> Self {
		// 1MiB chunks land in ~150ms each on a warm connection, which is small
		// enough that the first one reaches the player almost immediately and
		// large enough that per-request overhead stays irrelevant.
		Self { chunk_size: 1 << 20, concurrency: 4, attempts: 3 }
	}
}

/// Where a cached track and its sidecar live, in both their states.
#[derive(Debug, Clone)]
pub struct CachePaths {
	pub music: PathBuf,
	pub index: PathBuf,
	pub temp_music: PathBuf,
	pub temp_index: PathBuf,
}

impl CachePaths {
	/// Mirrors the layout the TypeScript side already uses: `<id>.music` when
	/// complete, `<id>.temp.music` while in flight.
	pub fn new(cache_dir: &Path, video_id: &str) -> Self {
		Self {
			music: cache_dir.join(format!("{video_id}.music")),
			index: cache_dir.join(format!("{video_id}.idx")),
			temp_music: cache_dir.join(format!("{video_id}.temp.music")),
			temp_index: cache_dir.join(format!("{video_id}.temp.idx")),
		}
	}

	async fn discard_temps(&self) {
		let _ = tokio::fs::remove_file(&self.temp_music).await;
		let _ = tokio::fs::remove_file(&self.temp_index).await;
	}
}

#[derive(Debug, Clone, Copy)]
pub struct DownloadSummary {
	pub bytes: u64,
	pub frames: u64,
	pub duration_ms: u32,
	pub elapsed: Duration,
}

/// Fetch `format` into the cache, indexing as it goes.
///
/// A failure leaves nothing behind: the temporary files are removed rather than
/// promoted, so a killed or errored download can never be mistaken for a cache
/// hit on the next play.
pub async fn download(
	client: &reqwest::Client,
	format: &AudioFormat,
	user_agent: &str,
	paths: &CachePaths,
	options: DownloadOptions,
	mut on_progress: impl FnMut(u64, u64),
) -> Result<DownloadSummary, DownloadError> {
	let started = Instant::now();
	match run(client, format, user_agent, paths, options, &mut on_progress).await {
		Ok(mut summary) => {
			summary.elapsed = started.elapsed();
			Ok(summary)
		}
		Err(error) => {
			paths.discard_temps().await;
			Err(error)
		}
	}
}

async fn run(
	client: &reqwest::Client,
	format: &AudioFormat,
	user_agent: &str,
	paths: &CachePaths,
	options: DownloadOptions,
	on_progress: &mut impl FnMut(u64, u64),
) -> Result<DownloadSummary, DownloadError> {
	if let Some(parent) = paths.temp_music.parent() {
		tokio::fs::create_dir_all(parent).await?;
	}

	// `contentLength` is normally present; when it is not, one probing range
	// reveals the total from the Content-Range header.
	let total = match format.content_length {
		0 => probe_length(client, &format.url, user_agent).await?,
		known => known,
	};

	let mut file = tokio::fs::File::create(&paths.temp_music).await?;
	let mut indexer = CacheIndexer::create(&paths.temp_index)?;
	let mut written = 0u64;

	let ranges: Vec<(u64, u64)> = (0..total)
		.step_by(options.chunk_size as usize)
		.map(|start| (start, (start + options.chunk_size).min(total) - 1))
		.collect();

	let mut chunks = futures_util::stream::iter(ranges)
		.map(|(start, end)| {
			fetch_range(client, &format.url, user_agent, start, end, options.attempts)
		})
		.buffered(options.concurrency);

	while let Some(chunk) = chunks.next().await {
		let bytes = chunk?;
		file.write_all(&bytes).await?;
		// Indexing runs on the same thread as the write. It costs a few
		// microseconds per megabyte, far below the network wait it hides behind.
		indexer.feed(&bytes)?;
		written += bytes.len() as u64;
		on_progress(written, total);
	}

	if written == 0 {
		return Err(DownloadError::Empty);
	}

	file.flush().await?;
	file.sync_data().await?;
	drop(file);
	let summary = indexer.finish()?;

	// Publish both files only once both are whole, and the audio before the
	// index: a reader that finds an index must find the audio it describes.
	tokio::fs::rename(&paths.temp_music, &paths.music).await?;
	tokio::fs::rename(&paths.temp_index, &paths.index).await?;

	Ok(DownloadSummary {
		bytes: written,
		frames: summary.frames,
		duration_ms: if summary.duration_ms > 0 { summary.duration_ms } else { format.duration_ms },
		elapsed: Duration::ZERO,
	})
}

/// Ask for the first byte and read the total out of `Content-Range`.
async fn probe_length(
	client: &reqwest::Client,
	url: &str,
	user_agent: &str,
) -> Result<u64, DownloadError> {
	let response = client
		.get(url)
		.header("Range", "bytes=0-0")
		.header("User-Agent", user_agent)
		.send()
		.await?
		.error_for_status()?;
	let total = response
		.headers()
		.get(reqwest::header::CONTENT_RANGE)
		.and_then(|value| value.to_str().ok())
		.and_then(|value| value.rsplit('/').next()?.parse::<u64>().ok());
	match total {
		Some(total) if total > 0 => Ok(total),
		// Without a length there is nothing to divide into ranges, and an
		// unranged GET is the throttled path this module exists to avoid.
		_ => Err(DownloadError::NoRangeSupport {
			offset: 0,
			status: response.status().as_u16(),
		}),
	}
}

/// One chunk, retried on transient failure.
///
/// Retries matter more here than elsewhere: a download is dozens of requests
/// and any one of them failing would otherwise discard the whole track.
async fn fetch_range(
	client: &reqwest::Client,
	url: &str,
	user_agent: &str,
	start: u64,
	end: u64,
	attempts: u32,
) -> Result<bytes::Bytes, DownloadError> {
	let mut last: Option<reqwest::Error> = None;

	for attempt in 0..attempts {
		if attempt > 0 {
			// 100ms, 200ms, 400ms — enough to ride out a reset, short enough
			// that the listener does not notice.
			tokio::time::sleep(Duration::from_millis(100 << (attempt - 1))).await;
		}

		let response = match client
			.get(url)
			.header("Range", format!("bytes={start}-{end}"))
			.header("User-Agent", user_agent)
			.send()
			.await
		{
				Ok(response) => response,
				Err(error) => {
					last = Some(error);
					continue;
				}
			};

		let status = response.status();
		if status != reqwest::StatusCode::PARTIAL_CONTENT {
			// A 200 here means the server ignored the range and is about to
			// stream the whole file at throttled speed. Refuse rather than
			// silently write the wrong bytes at the wrong offset.
			return Err(DownloadError::NoRangeSupport { offset: start, status: status.as_u16() });
		}

		match response.bytes().await {
			Ok(bytes) => return Ok(bytes),
			Err(error) => last = Some(error),
		}
	}

	Err(DownloadError::ChunkFailed {
		offset: start,
		attempts,
		source: last.expect("at least one attempt ran"),
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn cache_paths_match_the_typescript_layout() {
		let paths = CachePaths::new(Path::new("/srv/amhra/cache"), "dQw4w9WgXcQ");
		assert!(paths.music.ends_with("dQw4w9WgXcQ.music"));
		assert!(paths.index.ends_with("dQw4w9WgXcQ.idx"));
		assert!(paths.temp_music.ends_with("dQw4w9WgXcQ.temp.music"));
		assert!(paths.temp_index.ends_with("dQw4w9WgXcQ.temp.idx"));
	}

	#[test]
	fn ranges_cover_the_file_exactly() {
		let total = 2_500_000u64;
		let chunk = 1u64 << 20;
		let ranges: Vec<(u64, u64)> = (0..total)
			.step_by(chunk as usize)
			.map(|start| (start, (start + chunk).min(total) - 1))
			.collect();

		assert_eq!(ranges.len(), 3);
		assert_eq!(ranges[0], (0, 1_048_575));
		assert_eq!(ranges[2], (2_097_152, 2_499_999));
		let covered: u64 = ranges.iter().map(|(start, end)| end - start + 1).sum();
		assert_eq!(covered, total);
		// No overlaps: an overlap would corrupt the file with duplicated bytes.
		assert!(ranges.windows(2).all(|pair| pair[0].1 + 1 == pair[1].0));
	}

	#[test]
	fn default_options_bound_memory() {
		let options = DownloadOptions::default();
		assert!(options.chunk_size * options.concurrency as u64 <= 8 << 20);
	}
}
