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
//! A track streamed with caching off has no file at all. Its bytes arrive
//! through a [`StreamFeed`], are demuxed on arrival, and are kept in one buffer
//! for as long as the reader lives, so it seeks both ways like a file does.
//! Dropping the reader is what gives the memory back.
//!
//! The `.idx` sidecar is not needed to seek within a file this reader has
//! already walked; it answers the questions asked *before* that — how long is
//! this, is it complete, how much of it has landed — and it answers them
//! without a parse pass, which is what a queue or a dashboard wants.

use std::fs::File;
use std::path::{Path, PathBuf};

use memmap2::Mmap;

use crate::index::{self, Header};
use crate::stream::{Arrival, StreamFeed};
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

/// Where a track's bytes live.
enum Backing {
	/// A cache file, mapped. The page cache owns the memory.
	File { path: PathBuf, file: File, map: Mmap },
	/// A download with no file behind it, held whole until the reader goes.
	Stream { feed: StreamFeed, bytes: Vec<u8> },
}

/// One track, open for playback.
pub struct CacheReader {
	backing: Backing,
	/// Bytes of the backing already demuxed.
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
	/// A seek past what has arrived, waiting for the audio to reach it.
	///
	/// Clamping to the last frame instead would start a resumed track from
	/// wherever its download happened to be — from the top, for a stream that
	/// has not delivered a byte yet.
	pending_seek: Option<u32>,
}

impl std::fmt::Debug for CacheReader {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		let source = match &self.backing {
			Backing::File { path, .. } => path.display().to_string(),
			Backing::Stream { .. } => "stream".to_owned(),
		};
		f.debug_struct("CacheReader")
			.field("source", &source)
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
		let mut reader = Self::with_backing(
			Backing::File { path: path.to_path_buf(), file, map },
			header,
		);
		reader.demux_mapped()?;
		Ok(reader)
	}

	/// Follow a download that is not being written anywhere.
	///
	/// Starts empty: the bytes arrive on `refresh`, like a cache file's do, and
	/// the stream is complete once its writer is gone.
	pub fn streaming(feed: StreamFeed) -> Self {
		Self::with_backing(
			Backing::Stream { feed, bytes: Vec::new() },
			None,
		)
	}

	fn with_backing(backing: Backing, header: Option<Header>) -> Self {
		Self {
			backing,
			consumed: 0,
			demuxer: WebmDemuxer::new(),
			frames: Vec::new(),
			cursor: 0,
			header,
			complete: header.is_some_and(|header| header.complete),
			pending_seek: None,
		}
	}

	/// Frames discovered so far — on a stream, those not yet trimmed away.
	pub fn frame_count(&self) -> usize {
		self.frames.len()
	}

	/// Playback position of the next frame.
	pub fn position_ms(&self) -> u32 {
		if let Some(target) = self.pending_seek {
			return target;
		}
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
	/// The slice borrows the mapping or the stream's buffer, so nothing is
	/// copied and nothing is allocated on this path.
	pub fn next_frame(&mut self) -> Option<(&[u8], Frame)> {
		let frame = *self.frames.get(self.cursor)?;
		self.cursor += 1;
		let source: &[u8] = match &self.backing {
			Backing::File { map, .. } => map,
			Backing::Stream { bytes, .. } => bytes,
		};
		let start = frame.offset as usize;
		// A frame the demuxer found must lie inside the bytes it was found in;
		// fewer here would mean the file was replaced underneath.
		let bytes = source.get(start..start + frame.len as usize)?;
		Some((bytes, frame))
	}

	/// Move playback to `timestamp_ms`, landing on the last frame at or before
	/// it. Returns the position actually reached.
	///
	/// A target the download has not reached yet is held rather than clamped:
	/// the reader reports itself drained until the audio gets there, then
	/// lands on it. Once the track is complete, a target past its end lands on
	/// the last frame.
	pub fn seek(&mut self, timestamp_ms: u32) -> u32 {
		self.pending_seek = None;
		if !self.complete && timestamp_ms >= self.buffered_ms() {
			self.pending_seek = Some(timestamp_ms);
			self.cursor = self.frames.len();
			return timestamp_ms;
		}
		if self.frames.is_empty() {
			return 0;
		}
		// partition_point is the first frame *after* the target, so the one
		// before it is the frame that contains the target.
		let position = self.frames.partition_point(|frame| frame.timestamp_ms <= timestamp_ms);
		self.cursor = position.saturating_sub(1);
		self.frames[self.cursor].timestamp_ms
	}

	/// Pick up whatever has been appended since the last call, and whether the
	/// download has since finished.
	///
	/// Cheap when nothing has changed: one `stat`, no remap, no parsing — plus
	/// two more while a temp file is still open, which is only ever a track
	/// that is still arriving.
	pub fn refresh(&mut self) -> Result<bool, ReaderError> {
		let grew = match self.backing {
			Backing::File { .. } => {
				let grew = self.remap()?;
				if grew {
					self.demux_mapped()?;
				}
				grew
			}
			Backing::Stream { .. } => self.take_stream()?,
		};
		self.settle_pending_seek();
		Ok(grew)
	}

	/// Remap a file that has grown, returning whether it did.
	fn remap(&mut self) -> Result<bool, ReaderError> {
		match &mut self.backing {
			Backing::File { path, file, map } => {
				// Checked before the length is read: the fetcher renames only
				// after its last write is synced, so once the rename is seen,
				// the length read next is the whole file.
				if !self.complete && download_published(path) {
					self.complete = true;
				}
				let length = file.metadata()?.len();
				if length <= map.len() as u64 {
					return Ok(false);
				}
				// SAFETY: as in `open_path` — append-only until rename.
				*map = unsafe { Mmap::map(&*file)? };
				#[cfg(unix)]
				let _ = map.advise(memmap2::Advice::WillNeed);
				Ok(true)
			}
			Backing::Stream { .. } => Ok(false),
		}
	}

	/// Demux and keep everything a stream has delivered, returning whether
	/// there was anything.
	fn take_stream(&mut self) -> Result<bool, ReaderError> {
		let Backing::Stream { feed, bytes } = &mut self.backing else { return Ok(false) };
		let mut grew = false;
		loop {
			match feed.poll() {
				Arrival::Expect(total) => {
					let total = usize::try_from(total).unwrap_or(usize::MAX);
					bytes.reserve_exact(total.saturating_sub(bytes.len()));
				}
				Arrival::Bytes(chunk) => {
					let frames = &mut self.frames;
					self.demuxer.feed(&chunk, &mut |frame| frames.push(frame))?;
					self.consumed += chunk.len() as u64;
					// Nothing reserved, the first chunk can simply become the
					// buffer instead of being copied into an empty one.
					if bytes.is_empty() && bytes.capacity() < chunk.len() {
						*bytes = chunk;
					} else {
						bytes.extend_from_slice(&chunk);
					}
					grew = true;
				}
				Arrival::Waiting => break,
				// The channel delivers in order and its end comes last, so every
				// byte the writer sent is already here.
				Arrival::Ended => {
					self.complete = true;
					break;
				}
			}
		}
		Ok(grew)
	}

	/// Land a held seek once the audio has reached it, or once it never will.
	fn settle_pending_seek(&mut self) {
		let Some(target) = self.pending_seek else { return };
		if target < self.buffered_ms() || self.complete {
			self.seek(target);
		} else {
			// Frames demuxed meanwhile are all before the target, and playing
			// them would be playing from the wrong place.
			self.cursor = self.frames.len();
		}
	}

	/// Demux everything in the mapping that has not been demuxed yet.
	fn demux_mapped(&mut self) -> Result<(), ReaderError> {
		let Backing::File { map, .. } = &self.backing else { return Ok(()) };
		let bytes: &[u8] = map;
		let available = bytes.len() as u64;
		if available <= self.consumed {
			return Ok(());
		}
		let start = self.consumed as usize;
		let chunk = &bytes[start..];
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

/// Whether the temp file a reader opened has been renamed into place.
///
/// The open handle follows the file through the rename, so the bytes are
/// already ours; what the rename adds is the one thing the bytes cannot say,
/// that there will be no more of them. Both download paths rename only on
/// success, and a failed one deletes the temp file without publishing anything,
/// so that does not count.
fn download_published(path: &Path) -> bool {
	let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
		return false;
	};
	let Some(id) = name.strip_suffix(".temp.music") else { return false };
	!path.exists() && path.with_file_name(format!("{id}.music")).exists()
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

	/// A track starts playing from the temp file while it downloads. When the
	/// download finishes and the file is renamed into place, the open reader
	/// must learn the track is whole, or the player waits at the end of it
	/// forever and the queue never moves on.
	#[test]
	fn a_download_finishing_under_an_open_reader_completes_it() {
		let mut dir = std::env::temp_dir();
		dir.push(format!("amhra-reader-rename-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let temp = dir.join("track.temp.music");
		let whole = webm(4, 50);
		let half = whole.len() / 2;
		std::fs::write(&temp, &whole[..half]).unwrap();

		let mut reader = CacheReader::open(&dir, "track").unwrap();
		assert!(!reader.is_complete());
		while reader.next_frame().is_some() {}

		// The fetcher writes the rest, then renames as its very last step.
		let mut file = std::fs::OpenOptions::new().append(true).open(&temp).unwrap();
		file.write_all(&whole[half..]).unwrap();
		file.sync_data().unwrap();
		drop(file);
		std::fs::rename(&temp, dir.join("track.music")).unwrap();

		assert!(reader.refresh().unwrap(), "the rest of the audio should be picked up");
		assert!(reader.is_complete(), "the rename means the download is done");
		let mut rest = 0;
		while reader.next_frame().is_some() {
			rest += 1;
		}
		assert_eq!(reader.frame_count(), 200, "nothing written before the rename is lost");
		assert!(rest > 0);
		std::fs::remove_dir_all(&dir).ok();
	}

	#[test]
	fn a_temp_file_that_vanishes_without_a_rename_is_not_complete() {
		// A failed download deletes its temp file and publishes nothing; that
		// must not read as the track having finished.
		let mut dir = std::env::temp_dir();
		dir.push(format!("amhra-reader-failed-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let temp = dir.join("track.temp.music");
		let whole = webm(4, 50);
		std::fs::write(&temp, &whole[..whole.len() / 2]).unwrap();

		let mut reader = CacheReader::open(&dir, "track").unwrap();
		std::fs::remove_file(&temp).unwrap();
		reader.refresh().unwrap();
		assert!(!reader.is_complete());
		std::fs::remove_dir_all(&dir).ok();
	}

	#[test]
	fn a_stream_plays_as_it_arrives_and_ends_when_its_writer_does() {
		let whole = webm(4, 50);
		let (mut writer, feed) = crate::stream::channel();
		let mut reader = CacheReader::streaming(feed);
		assert_eq!(reader.frame_count(), 0);
		assert!(reader.is_drained() && !reader.is_complete());

		// Split mid-element, the way network chunks fall.
		let cut = whole.len() / 3;
		writer.push(&whole[..cut]);
		assert!(reader.refresh().unwrap());
		let early = reader.frame_count();
		assert!(early > 0 && early < 200, "expected part of the track, got {early} frames");
		while reader.next_frame().is_some() {}
		assert!(!reader.is_complete(), "running dry mid-stream is not the end");

		writer.push(&whole[cut..]);
		drop(writer);
		assert!(reader.refresh().unwrap());
		assert!(reader.is_complete());
		assert_eq!(reader.frame_count(), 200);
		let mut rest = 0;
		while let Some((bytes, _)) = reader.next_frame() {
			assert_eq!(bytes[0], 0xfc, "frame does not start at a TOC byte");
			rest += 1;
		}
		assert_eq!(rest, 200 - early);
	}

	#[test]
	fn a_seek_past_the_download_waits_for_the_audio_to_reach_it() {
		let whole = webm(4, 50);
		let (mut writer, feed) = crate::stream::channel();
		let mut reader = CacheReader::streaming(feed);

		// A resumed track asks for its position before a byte has arrived.
		assert_eq!(reader.seek(3_000), 3_000);
		assert_eq!(reader.position_ms(), 3_000);

		writer.push(&whole[..whole.len() / 2]);
		reader.refresh().unwrap();
		assert!(reader.is_drained(), "nothing before the target may play");
		assert_eq!(reader.position_ms(), 3_000);

		writer.push(&whole[whole.len() / 2..]);
		reader.refresh().unwrap();
		let (_, frame) = reader.next_frame().expect("the target has arrived");
		assert_eq!(frame.timestamp_ms, 3_000);
	}

	#[test]
	fn a_held_seek_past_the_end_lands_on_the_last_frame_once_complete() {
		let whole = webm(2, 50);
		let (mut writer, feed) = crate::stream::channel();
		let mut reader = CacheReader::streaming(feed);
		reader.seek(60_000);
		writer.push(&whole);
		drop(writer);
		reader.refresh().unwrap();
		let (_, frame) = reader.next_frame().expect("clamped to the last frame");
		assert_eq!(frame.timestamp_ms, 1_980);
	}

	#[test]
	fn a_stream_keeps_its_whole_track_so_it_can_seek_back() {
		let whole = webm(60, 50);
		let (mut writer, feed) = crate::stream::channel();
		let mut reader = CacheReader::streaming(feed);
		writer.expect(whole.len() as u64);
		// In network-sized chunks, so frames straddle the boundaries.
		for chunk in whole.chunks(4_096) {
			writer.push(chunk);
		}
		drop(writer);
		reader.refresh().unwrap();
		let held = |reader: &CacheReader| match &reader.backing {
			Backing::Stream { bytes, .. } => (bytes.len(), bytes.capacity()),
			Backing::File { .. } => unreachable!(),
		};
		assert_eq!(held(&reader), (whole.len(), whole.len()), "allocated once, at its size");

		let mut first = None;
		while let Some((bytes, _)) = reader.next_frame() {
			first.get_or_insert_with(|| bytes.to_vec());
		}
		assert_eq!(reader.frame_count(), 3_000);

		// Played to the end, and the start is still there.
		assert_eq!(reader.seek(0), 0);
		let (bytes, frame) = reader.next_frame().expect("the start of the track");
		assert_eq!(frame.timestamp_ms, 0);
		assert_eq!(Some(bytes.to_vec()), first, "seeking back replayed different audio");
	}

	#[test]
	fn a_stream_that_fails_before_any_audio_is_an_empty_finished_track() {
		let (writer, feed) = crate::stream::channel();
		let mut reader = CacheReader::streaming(feed);
		drop(writer);
		assert!(!reader.refresh().unwrap());
		assert!(reader.is_complete() && reader.is_drained());
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
