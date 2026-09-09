//! Reading Opus frames back out of the cache, including while it downloads.
//!
//! The file is memory-mapped and demuxed incrementally, so playback never
//! copies audio: a frame handed to the caller is a slice of the mapping, and
//! the mapping is the page cache. What the reader keeps is a table of frame
//! positions — twenty bytes each, about 600KB for a ten-minute track — which is
//! what makes seeking a binary search rather than a rescan.
//!
//! A track still downloading grows under us. `refresh` notices, remaps, and
//! demuxes only the bytes that arrived since last time, because the demuxer is
//! resumable and does not care where a chunk boundary fell.
//!
//! The `.idx` sidecar is not needed to seek within a file this reader has
//! already walked; it answers the questions asked *before* that — how long is
//! this, is it complete, how much of it has landed — and it answers them
//! without a parse pass, which is what a queue or a dashboard wants.

use std::fs::File;
use std::path::{Path, PathBuf};

use memmap2::Mmap;

use crate::index::{self, Header};
use crate::webm::{DemuxError, Frame, WebmDemuxer};

#[derive(Debug, thiserror::Error)]
pub enum ReaderError {
	#[error("no cache file for {0}")]
	Missing(String),
	#[error("i/o: {0}")]
	Io(#[from] std::io::Error),
	#[error("demux: {0}")]
	Demux(#[from] DemuxError),
}

/// One track, open for playback.
pub struct CacheReader {
	path: PathBuf,
	file: File,
	map: Mmap,
	/// Bytes of `map` already demuxed.
	consumed: u64,
	demuxer: WebmDemuxer,
	frames: Vec<Frame>,
	/// Index into `frames` of the next frame to hand out.
	cursor: usize,
	header: Option<Header>,
	/// Whether the download is known to have finished.
	///
	/// Only ever set from something that actually knows — a finalised index, or
	/// having opened the renamed `<id>.music` rather than the temp file. A
	/// truncated file can be named anything, so the name proves nothing, and
	/// guessing "complete" here would end a track early.
	complete: bool,
}

impl std::fmt::Debug for CacheReader {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("CacheReader")
			.field("path", &self.path)
			.field("frames", &self.frames.len())
			.field("cursor", &self.cursor)
			.field("complete", &self.is_complete())
			.finish_non_exhaustive()
	}
}

impl CacheReader {
	/// Open `<id>.music`, or the partial `<id>.temp.music` if that is all there
	/// is yet.
	///
	/// Resolved per call rather than remembered: a download completing renames
	/// the temp file, so a path captured earlier can vanish underneath.
	pub fn open(cache_dir: &Path, video_id: &str) -> Result<Self, ReaderError> {
		let complete = cache_dir.join(format!("{video_id}.music"));
		let partial = cache_dir.join(format!("{video_id}.temp.music"));
		let (path, renamed) = if complete.exists() {
			(complete, true)
		} else if partial.exists() {
			(partial, false)
		} else {
			return Err(ReaderError::Missing(video_id.to_owned()));
		};

		let header = index::read_header(&cache_dir.join(format!("{video_id}.idx"))).ok();
		let mut reader = Self::open_path(&path, header)?;
		reader.complete = renamed || reader.complete;
		Ok(reader)
	}

	pub fn open_path(path: &Path, header: Option<Header>) -> Result<Self, ReaderError> {
		let file = File::open(path)?;
		// SAFETY: the cache is append-only until it is renamed into place, so
		// the mapping cannot shrink while it is held.
		let map = unsafe { Mmap::map(&file)? };
		// Opening a track walks the whole mapping once, front to back, before a
		// single frame is played, so every page is wanted and asking for them in
		// one call beats taking a fault per page from the parse loop — measured
		// at 9.3ms against 5.7ms on a 60MiB track. Advisory: a kernel that
		// declines is not an error, it just leaves the faults where they were.
		#[cfg(unix)]
		let _ = map.advise(memmap2::Advice::WillNeed);
		let mut reader = Self {
			path: path.to_path_buf(),
			file,
			map,
			consumed: 0,
			demuxer: WebmDemuxer::new(),
			frames: Vec::new(),
			cursor: 0,
			header,
			complete: header.is_some_and(|header| header.complete),
		};
		reader.demux_available()?;
		Ok(reader)
	}

	/// Total frames discovered so far.
	pub fn frame_count(&self) -> usize {
		self.frames.len()
	}

	/// Playback position of the next frame.
	pub fn position_ms(&self) -> u32 {
		self.frames.get(self.cursor).map_or_else(|| self.buffered_ms(), |frame| frame.timestamp_ms)
	}

	/// How much audio has been demuxed, whether or not it has been played.
	pub fn buffered_ms(&self) -> u32 {
		self.frames
			.last()
			.map_or(0, |frame| frame.timestamp_ms + frame.duration_us / 1000)
	}

	/// Duration from the container, when it declared one.
	pub fn duration_ms(&self) -> Option<u32> {
		self.demuxer
			.declared_duration_ms()
			.or_else(|| self.header.map(|header| header.duration_ms).filter(|ms| *ms > 0))
	}

	pub fn is_complete(&self) -> bool {
		self.complete
	}

	/// Tell the reader the download has finished, when the caller learns it
	/// from somewhere this reader cannot see.
	pub fn mark_complete(&mut self) {
		self.complete = true;
	}

	/// Whether every frame demuxed so far has been handed out.
	pub fn is_drained(&self) -> bool {
		self.cursor >= self.frames.len()
	}

	/// Take the next Opus packet, or `None` when the reader has caught up with
	/// the download.
	///
	/// The slice borrows the mapping, so nothing is copied and nothing is
	/// allocated on this path.
	pub fn next_frame(&mut self) -> Option<(&[u8], Frame)> {
		let frame = *self.frames.get(self.cursor)?;
		self.cursor += 1;
		let start = frame.offset as usize;
		let end = start + frame.len as usize;
		// A frame the demuxer found must lie inside the mapping it was found
		// in; a shorter map here would mean the file was replaced underneath.
		let bytes = self.map.get(start..end)?;
		Some((bytes, frame))
	}

	/// Move playback to `timestamp_ms`, landing on the last frame at or before
	/// it. Returns the position actually reached.
	pub fn seek(&mut self, timestamp_ms: u32) -> u32 {
		if self.frames.is_empty() {
			return 0;
		}
		// partition_point is the first frame *after* the target, so the one
		// before it is the frame that contains the target.
		let position = self.frames.partition_point(|frame| frame.timestamp_ms <= timestamp_ms);
		self.cursor = position.saturating_sub(1);
		self.frames[self.cursor].timestamp_ms
	}

	/// Pick up whatever has been appended since the last call.
	///
	/// Cheap when nothing has changed: one `stat`, no remap, no parsing.
	pub fn refresh(&mut self) -> Result<bool, ReaderError> {
		let length = self.file.metadata()?.len();
		if length <= self.map.len() as u64 {
			return Ok(false);
		}
		// SAFETY: as in `open_path` — append-only until rename.
		self.map = unsafe { Mmap::map(&self.file)? };
		#[cfg(unix)]
		let _ = self.map.advise(memmap2::Advice::WillNeed);
		self.demux_available()?;
		Ok(true)
	}

	/// Demux everything in the mapping that has not been demuxed yet.
	fn demux_available(&mut self) -> Result<(), ReaderError> {
		let available = self.map.len() as u64;
		if available <= self.consumed {
			return Ok(());
		}
		let start = self.consumed as usize;
		let chunk = &self.map[start..];
		// Growing the table one doubling at a time copies it repeatedly: a
		// ten-minute track is 30k entries, an hour-long one 180k, and the copies
		// land in the middle of opening a track. The average frame size seen so
		// far predicts the rest of the file closely, since a track is one
		// encoder's output at one bitrate.
		let bytes_per_frame =
			if self.frames.is_empty() { 400 } else { (start / self.frames.len()).max(64) };
		self.frames.reserve(chunk.len() / bytes_per_frame + 16);
		let frames = &mut self.frames;
		self.demuxer.feed(chunk, &mut |frame| frames.push(frame))?;
		self.consumed = available;
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::io::Write;

	/// Build a small WebM/Opus file the demuxer will accept.
	fn webm(clusters: usize, frames_per_cluster: usize) -> Vec<u8> {
		fn size_vint(value: u64) -> Vec<u8> {
			for width in 1..=8u32 {
				let max = (1u64 << (7 * width)) - 1;
				if value < max {
					let marked = value | (1u64 << (7 * width));
					return marked.to_be_bytes()[8 - width as usize..].to_vec();
				}
			}
			unreachable!()
		}
		fn element(id: &[u8], payload: &[u8]) -> Vec<u8> {
			let mut out = Vec::new();
			out.extend_from_slice(id);
			out.extend_from_slice(&size_vint(payload.len() as u64));
			out.extend_from_slice(payload);
			out
		}

		let mut head = Vec::from(*b"OpusHead");
		head.extend_from_slice(&[1, 2]);
		head.extend_from_slice(&312u16.to_le_bytes());
		head.extend_from_slice(&48_000u32.to_le_bytes());
		head.extend_from_slice(&0i16.to_le_bytes());
		head.push(0);

		let mut entry = element(&[0xd7], &[1]);
		entry.extend_from_slice(&element(&[0x86], b"A_OPUS"));
		entry.extend_from_slice(&element(&[0x63, 0xa2], &head));

		let mut segment = element(&[0x2a, 0xd7, 0xb1], &1_000_000u32.to_be_bytes());
		segment = element(&[0x15, 0x49, 0xa9, 0x66], &segment);
		segment.extend_from_slice(&element(&[0x16, 0x54, 0xae, 0x6b], &element(&[0xae], &entry)));

		for cluster in 0..clusters {
			let base = (cluster * frames_per_cluster * 20) as u16;
			let mut payload = element(&[0xe7], &base.to_be_bytes());
			for frame in 0..frames_per_cluster {
				let mut block = vec![0x81];
				block.extend_from_slice(&((frame * 20) as i16).to_be_bytes());
				block.push(0x80);
				block.push(0xfc);
				block.extend_from_slice(&[(cluster * frames_per_cluster + frame) as u8; 39]);
				payload.extend_from_slice(&element(&[0xa3], &block));
			}
			segment.extend_from_slice(&element(&[0x1f, 0x43, 0xb6, 0x75], &payload));
		}

		let mut file = element(&[0x1a, 0x45, 0xdf, 0xa3], &[0x42, 0x86, 0x81, 0x01]);
		file.extend_from_slice(&element(&[0x18, 0x53, 0x80, 0x67], &segment));
		file
	}

	fn temp_path(name: &str) -> PathBuf {
		let mut path = std::env::temp_dir();
		path.push(format!("amhra-reader-{name}-{}.music", std::process::id()));
		path
	}

	#[test]
	fn frames_come_back_in_order_and_point_at_real_audio() {
		let path = temp_path("order");
		std::fs::write(&path, webm(2, 50)).unwrap();
		let mut reader = CacheReader::open_path(&path, None).unwrap();

		assert_eq!(reader.frame_count(), 100);
		let mut previous = 0;
		let mut count = 0;
		while let Some((bytes, frame)) = reader.next_frame() {
			assert_eq!(bytes[0], 0xfc, "frame does not start at a TOC byte");
			assert_eq!(bytes.len(), 40);
			assert!(frame.timestamp_ms >= previous);
			previous = frame.timestamp_ms;
			count += 1;
		}
		assert_eq!(count, 100);
		assert!(reader.is_drained());
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn seek_lands_on_the_frame_containing_the_target() {
		let path = temp_path("seek");
		std::fs::write(&path, webm(4, 50)).unwrap();
		let mut reader = CacheReader::open_path(&path, None).unwrap();

		for target in [0u32, 19, 20, 21, 1_000, 3_999] {
			let landed = reader.seek(target);
			assert!(landed <= target, "seek({target}) overshot to {landed}");
			assert!(target - landed < 20, "seek({target}) landed {landed}, too early");
			let (_, frame) = reader.next_frame().expect("a frame after seeking");
			assert_eq!(frame.timestamp_ms, landed);
		}
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn seeking_backwards_replays_the_same_audio() {
		let path = temp_path("rewind");
		std::fs::write(&path, webm(2, 50)).unwrap();
		let mut reader = CacheReader::open_path(&path, None).unwrap();

		reader.seek(500);
		let (first, _) = reader.next_frame().unwrap();
		let first = first.to_vec();
		for _ in 0..10 {
			reader.next_frame();
		}
		reader.seek(500);
		let (again, _) = reader.next_frame().unwrap();
		assert_eq!(first, again, "the same timestamp gave different audio");
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn a_growing_file_is_picked_up_without_re_reading_it() {
		let path = temp_path("live");
		let whole = webm(4, 50);
		// Start with only the first half on disk, as a download in flight.
		let half = whole.len() / 2;
		std::fs::write(&path, &whole[..half]).unwrap();

		let mut reader = CacheReader::open_path(&path, None).unwrap();
		let partial = reader.frame_count();
		assert!(partial > 0 && partial < 200, "expected a partial file, got {partial} frames");
		assert!(!reader.refresh().unwrap(), "nothing has been appended yet");

		// The rest lands.
		let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
		file.write_all(&whole[half..]).unwrap();
		file.sync_data().unwrap();

		assert!(reader.refresh().unwrap(), "the reader should notice growth");
		assert_eq!(reader.frame_count(), 200);

		// Frames found before the refresh must not have been re-emitted or
		// shifted: playback would stutter or repeat.
		reader.seek(0);
		let mut timestamps = Vec::new();
		while let Some((_, frame)) = reader.next_frame() {
			timestamps.push(frame.timestamp_ms);
		}
		assert_eq!(timestamps.len(), 200);
		assert!(timestamps.windows(2).all(|pair| pair[1] > pair[0]));
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn draining_a_partial_file_is_not_the_end_of_the_track() {
		let path = temp_path("drain");
		let whole = webm(4, 50);
		std::fs::write(&path, &whole[..whole.len() / 2]).unwrap();
		let mut reader = CacheReader::open_path(&path, None).unwrap();

		while reader.next_frame().is_some() {}
		// Drained, but the file is still growing: the player must wait, not
		// treat this as the track ending.
		assert!(reader.is_drained());
		assert!(!reader.is_complete());
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn a_missing_track_is_an_error_not_an_empty_reader() {
		let dir = std::env::temp_dir();
		assert!(matches!(
			CacheReader::open(&dir, "definitely-not-cached-xyz"),
			Err(ReaderError::Missing(_))
		));
	}
}
