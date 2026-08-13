//! YouTube audio fetching: extract a direct Opus URL, then pull it into the
//! cache as an indexed, passthrough-ready file.

pub mod download;
pub mod format;
pub mod innertube;
pub mod ytdlp;

use std::path::{Path, PathBuf};

use download::{CachePaths, DownloadOptions};
use innertube::Extractor;

/// Which path produced a cache entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
	/// Already on disk.
	Cache,
	/// Native extractor plus ranged download.
	InnerTube,
	/// yt-dlp subprocess.
	YtDlp,
}

impl Source {
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Cache => "cache",
			Self::InnerTube => "innertube",
			Self::YtDlp => "yt-dlp",
		}
	}
}

#[derive(Debug, Clone)]
pub struct FetchResult {
	pub video_id: String,
	pub title: Option<String>,
	pub path: PathBuf,
	pub index_path: Option<PathBuf>,
	pub bytes: u64,
	pub frames: u64,
	pub duration_ms: u32,
	pub itag: Option<u32>,
	pub source: Source,
	pub profile: Option<String>,
	pub elapsed_ms: u64,
	/// Why the native path was not used, when it was not.
	pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FetchOptions {
	pub cache_dir: PathBuf,
	pub profiles: Option<PathBuf>,
	pub download: DownloadOptions,
	pub allow_fallback: bool,
	/// Re-download even when the cache already has the track.
	pub force: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum FetchError {
	#[error("not a YouTube video: {0}")]
	BadInput(String),
	#[error(transparent)]
	Extract(#[from] innertube::ExtractError),
	#[error(transparent)]
	Download(#[from] download::DownloadError),
	#[error("native extraction failed ({native}), and yt-dlp fallback failed: {fallback}")]
	BothPathsFailed { native: String, fallback: String },
	#[error("i/o: {0}")]
	Io(#[from] std::io::Error),
}

/// Fetch a track into the cache, returning where it landed.
pub async fn fetch(
	input: &str,
	options: &FetchOptions,
	mut on_progress: impl FnMut(u64, u64),
) -> Result<FetchResult, FetchError> {
	let started = std::time::Instant::now();
	let video_id =
		innertube::video_id(input).ok_or_else(|| FetchError::BadInput(input.to_owned()))?;
	let paths = CachePaths::new(&options.cache_dir, &video_id);
	let url = format!("https://www.youtube.com/watch?v={video_id}");

	if !options.force
		&& let Some(hit) = cache_hit(&video_id, &paths).await?
	{
		return Ok(FetchResult { elapsed_ms: started.elapsed().as_millis() as u64, ..hit });
	}

	let native = match native_fetch(&video_id, &paths, options, &mut on_progress).await {
		Ok(mut result) => {
			result.elapsed_ms = started.elapsed().as_millis() as u64;
			return Ok(result);
		}
		Err(reason) => reason,
	};

	if !options.allow_fallback {
		return Err(FetchError::BothPathsFailed {
			native,
			fallback: "disabled by --no-fallback".to_owned(),
		});
	}

	match ytdlp::download(&url, &paths).await {
		Ok(summary) => Ok(FetchResult {
			video_id,
			title: None,
			path: paths.music,
			index_path: summary.indexed.then_some(paths.index),
			bytes: summary.bytes,
			frames: summary.frames,
			duration_ms: summary.duration_ms,
			itag: None,
			source: Source::YtDlp,
			profile: None,
			elapsed_ms: started.elapsed().as_millis() as u64,
			fallback_reason: Some(native),
		}),
		Err(error) => {
			Err(FetchError::BothPathsFailed { native, fallback: error.to_string() })
		}
	}
}

/// The native path: walk the profile ladder, downloading from the first
/// profile whose URL the CDN actually serves.
///
/// A URL can pass the player endpoint and still be refused by the media host —
/// YouTube runs bot checks in both places — so a rejected download resumes the
/// ladder at the next profile instead of surrendering to yt-dlp. Errors are
/// returned as one joined string because the caller only needs to explain, in a
/// log line, why the fallback ran.
async fn native_fetch(
	video_id: &str,
	paths: &CachePaths,
	options: &FetchOptions,
	on_progress: &mut impl FnMut(u64, u64),
) -> Result<FetchResult, String> {
	let profiles =
		innertube::load_profiles(options.profiles.as_deref()).map_err(|e| e.to_string())?;
	let extractor = Extractor::new(profiles).map_err(|e| e.to_string())?;

	let mut reasons: Vec<String> = Vec::new();
	let mut next = 0usize;

	while next < extractor.profile_count() {
		let attempt = match extractor.extract_from(video_id, next, &mut reasons).await {
			Ok(found) => found,
			Err(error) => {
				// The walk already recorded each profile's own refusal. Only the
				// conclusion drawn from them is new, and `Unplayable` just quotes
				// the last one back, so keep it out of the log twice.
				let text = error.to_string();
				if !reasons.last().is_some_and(|last| text.ends_with(last.as_str())) {
					reasons.push(text);
				}
				break;
			}
		};
		next = attempt.next;
		let extraction = attempt.extraction;

		match download::download(
			extractor.client(),
			&extraction.format,
			&extraction.user_agent,
			paths,
			options.download,
			&mut *on_progress,
		)
		.await
		{
			Ok(summary) => {
				return Ok(FetchResult {
					video_id: video_id.to_owned(),
					title: extraction.title,
					path: paths.music.clone(),
					index_path: Some(paths.index.clone()),
					bytes: summary.bytes,
					frames: summary.frames,
					duration_ms: if summary.duration_ms > 0 {
						summary.duration_ms
					} else {
						extraction.duration_ms
					},
					itag: Some(extraction.format.itag),
					source: Source::InnerTube,
					profile: Some(extraction.profile),
					elapsed_ms: 0,
					fallback_reason: None,
				});
			}
			Err(error) => reasons.push(format!("{}: {error}", extraction.profile)),
		}
	}

	Err(if reasons.is_empty() {
		"no client profile was usable".to_owned()
	} else {
		reasons.join("; ")
	})
}

/// Whether a cached track is already on disk, and what is known about it.
///
/// An entry downloaded before indexing existed is backfilled in place. One that
/// cannot be indexed at all — AAC, which yt-dlp falls back to when a video has
/// no Opus — is still a hit, reported with no index.
///
/// Reporting it as a miss instead would re-download it on every single play:
/// the fetch would succeed, produce the same un-indexable file, and be a miss
/// again next time. The file is there; what it lacks is passthrough playback,
/// and that is the caller's decision to make, not a reason to hit YouTube in a
/// loop.
async fn cache_hit(
	video_id: &str,
	paths: &CachePaths,
) -> Result<Option<FetchResult>, FetchError> {
	let Ok(metadata) = tokio::fs::metadata(&paths.music).await else {
		return Ok(None);
	};
	if metadata.len() == 0 {
		return Ok(None);
	}

	let mut indexed = tokio::fs::metadata(&paths.index).await.is_ok();
	if !indexed {
		indexed = ytdlp::backfill_index(&paths.music, &paths.index).await?;
	}

	let header =
		if indexed { amhra_audio::index::read_header(&paths.index).ok() } else { None };
	Ok(Some(FetchResult {
		video_id: video_id.to_owned(),
		title: None,
		path: paths.music.clone(),
		index_path: indexed.then(|| paths.index.clone()),
		bytes: metadata.len(),
		frames: 0,
		duration_ms: header.map_or(0, |header| header.duration_ms),
		itag: None,
		source: Source::Cache,
		profile: None,
		elapsed_ms: 0,
		fallback_reason: None,
	}))
}

/// Default cache directory, matching the TypeScript side's `cache/`.
pub fn default_cache_dir() -> PathBuf {
	Path::new("cache").to_path_buf()
}
