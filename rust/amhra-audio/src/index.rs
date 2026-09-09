//! The `.idx` sidecar: a coarse map from playback time to file offset.
//!
//! `.music` files stay exactly what the server sent — still playable in any
//! media player, still what a `ffmpeg` fallback would read. The index sits
//! beside them and answers the one question the container is bad at: where do I
//! start reading to hear second N?
//!
//! One entry per second keeps a two-hour track under 60KB while bounding the
//! post-seek scan to the frames inside a single second. Entries are appended
//! while the file downloads, so a reader following a live cache file can seek
//! within the part that has already landed.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

use memmap2::Mmap;

use crate::opus::OpusHead;
use crate::webm::Frame;

const MAGIC: [u8; 4] = *b"AMIX";
const VERSION: u8 = 1;
pub const HEADER_LEN: usize = 24;
pub const ENTRY_LEN: usize = 8;

/// The download is finished and the file is whole.
const FLAG_COMPLETE: u8 = 1 << 0;

/// Default spacing between index entries.
pub const DEFAULT_INTERVAL_MS: u16 = 1_000;

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
	#[error("index i/o: {0}")]
	Io(#[from] io::Error),
	#[error("not an amhra index")]
	BadMagic,
	#[error("unsupported index version {0}")]
	BadVersion(u8),
	#[error("index truncated: {0} bytes")]
	Truncated(usize),
}

/// One index entry: the offset of the first frame at or after `timestamp_ms`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
	pub offset: u32,
	pub timestamp_ms: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
	pub complete: bool,
	pub channels: u8,
	pub sample_rate: u32,
	pub pre_skip: u16,
	pub interval_ms: u16,
	/// Total duration if known. Zero while downloading.
	pub duration_ms: u32,
	/// Entries the writer claims. Trusted only once `complete`; a live reader
	/// counts what is actually on disk instead.
	pub entry_count: u32,
}

impl Header {
	fn encode(&self) -> [u8; HEADER_LEN] {
		let mut out = [0u8; HEADER_LEN];
		out[0..4].copy_from_slice(&MAGIC);
		out[4] = VERSION;
		out[5] = if self.complete { FLAG_COMPLETE } else { 0 };
		out[6] = self.channels;
		out[8..12].copy_from_slice(&self.sample_rate.to_le_bytes());
		out[12..14].copy_from_slice(&self.pre_skip.to_le_bytes());
		out[14..16].copy_from_slice(&self.interval_ms.to_le_bytes());
		out[16..20].copy_from_slice(&self.duration_ms.to_le_bytes());
		out[20..24].copy_from_slice(&self.entry_count.to_le_bytes());
		out
	}

	fn decode(bytes: &[u8]) -> Result<Self, IndexError> {
		if bytes.len() < HEADER_LEN {
			return Err(IndexError::Truncated(bytes.len()));
		}
		if bytes[0..4] != MAGIC {
			return Err(IndexError::BadMagic);
		}
		if bytes[4] != VERSION {
			return Err(IndexError::BadVersion(bytes[4]));
		}
		Ok(Self {
			complete: bytes[5] & FLAG_COMPLETE != 0,
			channels: bytes[6],
			sample_rate: u32::from_le_bytes(bytes[8..12].try_into().expect("4 bytes")),
			pre_skip: u16::from_le_bytes(bytes[12..14].try_into().expect("2 bytes")),
			interval_ms: u16::from_le_bytes(bytes[14..16].try_into().expect("2 bytes")),
			duration_ms: u32::from_le_bytes(bytes[16..20].try_into().expect("4 bytes")),
			entry_count: u32::from_le_bytes(bytes[20..24].try_into().expect("4 bytes")),
		})
	}
}

/// Builds an index while the `.music` file is being written.
///
/// Entries are flushed as they are produced rather than buffered, because the
/// point of writing them early is that another process can read them early.
#[derive(Debug)]
pub struct IndexWriter {
	file: File,
	header: Header,
	/// Timestamp the next entry must reach before it is worth recording.
	next_due_ms: u32,
	last_frame_end_ms: u32,
	/// Offsets are stored as u32; a source past 4GiB is not audio and gets no
	/// further entries rather than wrapping to a wrong offset.
	overflowed: bool,
}

impl IndexWriter {
	/// Create (or truncate) an index at `path`.
	pub fn create(path: &Path, interval_ms: u16) -> Result<Self, IndexError> {
		let file = OpenOptions::new().create(true).write(true).truncate(true).open(path)?;
		let header = Header {
			complete: false,
			channels: 0,
			sample_rate: crate::opus::SAMPLE_RATE,
			pre_skip: 0,
			interval_ms: interval_ms.max(1),
			duration_ms: 0,
			entry_count: 0,
		};
		let mut writer =
			Self { file, header, next_due_ms: 0, last_frame_end_ms: 0, overflowed: false };
		writer.write_header()?;
		Ok(writer)
	}

	/// Record the stream's `OpusHead` once the demuxer has seen `Tracks`.
	pub fn set_head(&mut self, head: OpusHead) -> Result<(), IndexError> {
		self.header.channels = head.channels;
		self.header.pre_skip = head.pre_skip;
		self.write_header()
	}

	/// Offer a frame to the index. Most frames are only counted; one per
	/// interval is written.
	pub fn observe(&mut self, frame: &Frame) -> Result<(), IndexError> {
		self.last_frame_end_ms = frame.timestamp_ms + frame.duration_us / 1000;
		if self.overflowed || frame.timestamp_ms < self.next_due_ms {
			return Ok(());
		}
		let Ok(offset) = u32::try_from(frame.offset) else {
			self.overflowed = true;
			return Ok(());
		};

		let mut entry = [0u8; ENTRY_LEN];
		entry[0..4].copy_from_slice(&offset.to_le_bytes());
		entry[4..8].copy_from_slice(&frame.timestamp_ms.to_le_bytes());
		self.file.write_all(&entry)?;

		self.header.entry_count += 1;
		// Stepping from the frame's own timestamp rather than from the previous
		// due time keeps entries from bunching up after a gap in the source.
		self.next_due_ms = frame.timestamp_ms + self.header.interval_ms as u32;
		Ok(())
	}

	/// Mark the index complete. `duration_ms` falls back to the end of the last
	/// frame seen when the container declared none.
	pub fn finalize(&mut self, duration_ms: Option<u32>) -> Result<(), IndexError> {
		self.header.complete = true;
		self.header.duration_ms = duration_ms.unwrap_or(self.last_frame_end_ms);
		self.write_header()?;
		self.file.sync_data()?;
		Ok(())
	}

	fn write_header(&mut self) -> Result<(), IndexError> {
		let position = self.file.stream_position()?;
		self.file.seek(SeekFrom::Start(0))?;
		self.file.write_all(&self.header.encode())?;
		// The first write leaves the cursor at the end of the header, which is
		// also where the first entry belongs; later ones must not rewind it.
		self.file.seek(SeekFrom::Start(position.max(HEADER_LEN as u64)))?;
		Ok(())
	}
}

/// A memory-mapped index, ready for seeking.
#[derive(Debug)]
pub struct Index {
	map: Mmap,
	header: Header,
}

impl Index {
	pub fn open(path: &Path) -> Result<Self, IndexError> {
		let file = File::open(path)?;
		// SAFETY: the index is only ever appended to and its header rewritten
		// in place, so a concurrent writer cannot shrink the mapping under us.
		let map = unsafe { Mmap::map(&file)? };
		let header = Header::decode(&map)?;
		Ok(Self { map, header })
	}

	pub fn header(&self) -> Header {
		self.header
	}

	/// Entries actually present on disk.
	///
	/// A live index is counted from the file length rather than the header,
	/// since the writer only publishes `entry_count` when it finalises. A torn
	/// trailing write is floored away by the division.
	pub fn len(&self) -> usize {
		let available = self.map.len().saturating_sub(HEADER_LEN) / ENTRY_LEN;
		if self.header.complete {
			available.min(self.header.entry_count as usize)
		} else {
			available
		}
	}

	pub fn is_empty(&self) -> bool {
		self.len() == 0
	}

	pub fn get(&self, position: usize) -> Option<Entry> {
		if position >= self.len() {
			return None;
		}
		let at = HEADER_LEN + position * ENTRY_LEN;
		let bytes = self.map.get(at..at + ENTRY_LEN)?;
		Some(Entry {
			offset: u32::from_le_bytes(bytes[0..4].try_into().expect("4 bytes")),
			timestamp_ms: u32::from_le_bytes(bytes[4..8].try_into().expect("4 bytes")),
		})
	}

	/// The entry to start demuxing from in order to reach `timestamp_ms`.
	///
	/// Always lands at or before the target so the caller can scan forward; the
	/// alternative would be starting mid-second and dropping audio the listener
	/// asked for. `None` only when nothing has been indexed yet.
	pub fn seek(&self, timestamp_ms: u32) -> Option<Entry> {
		let count = self.len();
		if count == 0 {
			return None;
		}
		// Binary search for the last entry at or before the target.
		let (mut low, mut high) = (0usize, count - 1);
		while low < high {
			let mid = (low + high).div_ceil(2);
			match self.get(mid) {
				Some(entry) if entry.timestamp_ms <= timestamp_ms => low = mid,
				_ => high = mid - 1,
			}
		}
		self.get(low).filter(|entry| entry.timestamp_ms <= timestamp_ms).or_else(|| self.get(0))
	}

	/// How much of the track is indexed so far — the seekable horizon while a
	/// download is still in flight.
	pub fn indexed_until_ms(&self) -> u32 {
		match self.len() {
			0 => 0,
			count => self.get(count - 1).map_or(0, |entry| entry.timestamp_ms),
		}
	}
}

/// Read just the header, without mapping the file.
pub fn read_header(path: &Path) -> Result<Header, IndexError> {
	let mut file = File::open(path)?;
	let mut bytes = [0u8; HEADER_LEN];
	file.read_exact(&mut bytes)?;
	Header::decode(&bytes)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn frame(offset: u64, timestamp_ms: u32) -> Frame {
		Frame { offset, len: 100, timestamp_ms, duration_us: 20_000 }
	}

	fn temp_path(name: &str) -> std::path::PathBuf {
		let mut path = std::env::temp_dir();
		path.push(format!("amhra-index-test-{name}-{}.idx", std::process::id()));
		path
	}

	#[test]
	fn writes_one_entry_per_interval() {
		let path = temp_path("interval");
		let mut writer = IndexWriter::create(&path, 1_000).unwrap();
		// 20ms frames across 5 seconds
		for i in 0..250u32 {
			writer.observe(&frame(i as u64 * 100, i * 20)).unwrap();
		}
		writer.finalize(None).unwrap();

		let index = Index::open(&path).unwrap();
		assert_eq!(index.len(), 5);
		assert_eq!(index.get(0).unwrap().timestamp_ms, 0);
		assert_eq!(index.get(1).unwrap().timestamp_ms, 1_000);
		assert_eq!(index.get(4).unwrap().timestamp_ms, 4_000);
		assert!(index.header().complete);
		// Last frame starts at 4980ms and runs 20ms.
		assert_eq!(index.header().duration_ms, 5_000);
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn seek_lands_at_or_before_target() {
		let path = temp_path("seek");
		let mut writer = IndexWriter::create(&path, 1_000).unwrap();
		for i in 0..500u32 {
			writer.observe(&frame(i as u64 * 100, i * 20)).unwrap();
		}
		writer.finalize(None).unwrap();

		let index = Index::open(&path).unwrap();
		for target in [0u32, 1, 999, 1_000, 4_321, 9_980] {
			let entry = index.seek(target).unwrap();
			assert!(entry.timestamp_ms <= target, "seek({target}) overshot to {entry:?}");
			assert!(
				target - entry.timestamp_ms < 1_000,
				"seek({target}) landed too early at {entry:?}"
			);
		}
		// Past the end: the last entry is the best answer.
		assert_eq!(index.seek(u32::MAX).unwrap().timestamp_ms, 9_000);
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn live_index_counts_what_is_on_disk() {
		let path = temp_path("live");
		let mut writer = IndexWriter::create(&path, 1_000).unwrap();
		for i in 0..150u32 {
			writer.observe(&frame(i as u64 * 100, i * 20)).unwrap();
		}
		// No finalize: this is what a reader sees mid-download.
		let index = Index::open(&path).unwrap();
		assert!(!index.header().complete);
		assert_eq!(index.len(), 3);
		assert_eq!(index.indexed_until_ms(), 2_000);
		assert_eq!(index.seek(2_500).unwrap().timestamp_ms, 2_000);
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn head_survives_later_entries() {
		let path = temp_path("head");
		let mut writer = IndexWriter::create(&path, 1_000).unwrap();
		writer
			.set_head(OpusHead {
				channels: 2,
				pre_skip: 312,
				input_sample_rate: 48_000,
				output_gain: 0,
			})
			.unwrap();
		for i in 0..100u32 {
			writer.observe(&frame(i as u64 * 100, i * 20)).unwrap();
		}
		writer.finalize(Some(2_000)).unwrap();

		let header = read_header(&path).unwrap();
		assert_eq!(header.channels, 2);
		assert_eq!(header.pre_skip, 312);
		assert_eq!(header.duration_ms, 2_000);
		assert_eq!(header.entry_count, 2);
		assert_eq!(Index::open(&path).unwrap().len(), 2);
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn foreign_files_are_rejected() {
		let path = temp_path("foreign");
		std::fs::write(&path, b"this is not an index at all").unwrap();
		assert!(matches!(Index::open(&path), Err(IndexError::BadMagic)));
		std::fs::remove_file(&path).ok();
	}
}
