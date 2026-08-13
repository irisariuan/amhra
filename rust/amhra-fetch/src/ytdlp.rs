//! yt-dlp fallback.
//!
//! The Rust extractor is the primary path, but YouTube changes without warning
//! and a music bot going deaf is worse than a music bot spawning python. When
//! every client profile fails, yt-dlp gets a turn — and the result is indexed
//! exactly like a native download, so playback cannot tell which path served it.
//!
//! yt-dlp is optional: if it is not installed, this simply reports that.

use std::path::Path;
use std::process::Stdio;

use amhra_audio::CacheIndexer;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::download::CachePaths;

#[derive(Debug, thiserror::Error)]
pub enum FallbackError {
	#[error("yt-dlp is not installed")]
	NotInstalled,
	#[error("yt-dlp exited with {code}: {stderr}")]
	Failed { code: i32, stderr: String },
	#[error("i/o: {0}")]
	Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Copy)]
pub struct FallbackSummary {
	pub bytes: u64,
	pub frames: u64,
	pub duration_ms: u32,
	/// False when yt-dlp handed back a container this build cannot demux —
	/// AAC, most often. The audio is cached, but there is no seek index and no
	/// passthrough playback for it.
	pub indexed: bool,
}

/// Download through yt-dlp into the same cache layout the native path uses.
pub async fn download(url: &str, paths: &CachePaths) -> Result<FallbackSummary, FallbackError> {
	// Opus first, in that order, so the fallback still produces a file the
	// player can pass through untouched whenever one exists.
	let args = [
		url,
		"--format",
		"251/250/249/bestaudio",
		"-q",
		"--no-playlist",
		"--force-ipv4",
		"-o",
		"-",
	];

	let mut child = match Command::new("yt-dlp")
		.args(args)
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
	{
		Ok(child) => child,
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
			return Err(FallbackError::NotInstalled);
		}
		Err(error) => return Err(error.into()),
	};

	let mut stdout = child.stdout.take().expect("stdout is piped");
	let mut stderr_pipe = child.stderr.take().expect("stderr is piped");

	let mut file = tokio::fs::File::create(&paths.temp_music).await?;
	let mut indexer = Some(CacheIndexer::create(&paths.temp_index).map_err(|error| {
		std::io::Error::other(format!("index: {error}"))
	})?);

	let mut buffer = vec![0u8; 256 * 1024];
	let mut written = 0u64;
	let mut demux_failed = false;

	loop {
		let read = stdout.read(&mut buffer).await?;
		if read == 0 {
			break;
		}
		use tokio::io::AsyncWriteExt;
		file.write_all(&buffer[..read]).await?;
		written += read as u64;

		// A non-WebM container is a normal outcome here, not an error: keep the
		// audio, drop the index, let the caller fall back to a decoding path.
		if let Some(active) = indexer.as_mut()
			&& active.feed(&buffer[..read]).is_err()
		{
			indexer = None;
			demux_failed = true;
		}
	}

	let status = child.wait().await?;
	if !status.success() {
		let mut stderr = String::new();
		let _ = stderr_pipe.read_to_string(&mut stderr).await;
		let _ = tokio::fs::remove_file(&paths.temp_music).await;
		let _ = tokio::fs::remove_file(&paths.temp_index).await;
		return Err(FallbackError::Failed {
			code: status.code().unwrap_or(-1),
			stderr: stderr.trim().chars().take(400).collect(),
		});
	}

	use tokio::io::AsyncWriteExt;
	file.flush().await?;
	file.sync_data().await?;
	drop(file);

	let summary = match indexer {
		Some(indexer) => indexer.finish().ok(),
		None => None,
	};

	tokio::fs::rename(&paths.temp_music, &paths.music).await?;
	if summary.is_some() {
		tokio::fs::rename(&paths.temp_index, &paths.index).await?;
	} else {
		let _ = tokio::fs::remove_file(&paths.temp_index).await;
	}

	Ok(FallbackSummary {
		bytes: written,
		frames: summary.map_or(0, |summary| summary.frames),
		duration_ms: summary.map_or(0, |summary| summary.duration_ms),
		indexed: summary.is_some() && !demux_failed,
	})
}

/// Whether yt-dlp can be found at all, for a startup log line.
pub async fn available() -> bool {
	Command::new("yt-dlp")
		.arg("--version")
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.status()
		.await
		.is_ok_and(|status| status.success())
}

/// Build an index for a `.music` file that was cached before indexing existed.
///
/// Returns `false` when the file is not WebM/Opus — the legacy AAC downloads —
/// in which case no index is written and the caller should treat the entry as
/// stale rather than playable by passthrough.
pub async fn backfill_index(music: &Path, index: &Path) -> std::io::Result<bool> {
	let mut file = tokio::fs::File::open(music).await?;
	let temp = index.with_extension("idx.partial");
	let mut indexer = match CacheIndexer::create(&temp) {
		Ok(indexer) => indexer,
		Err(error) => return Err(std::io::Error::other(format!("index: {error}"))),
	};

	let mut buffer = vec![0u8; 256 * 1024];
	loop {
		let read = file.read(&mut buffer).await?;
		if read == 0 {
			break;
		}
		if indexer.feed(&buffer[..read]).is_err() {
			let _ = tokio::fs::remove_file(&temp).await;
			return Ok(false);
		}
	}

	match indexer.finish() {
		Ok(_) => {
			tokio::fs::rename(&temp, index).await?;
			Ok(true)
		}
		Err(_) => {
			let _ = tokio::fs::remove_file(&temp).await;
			Ok(false)
		}
	}
}
