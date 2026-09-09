//! Matroska/WebM demuxer for the first `A_OPUS` track.
//!
//! Ported from the TypeScript demuxer with one change that matters: nothing is
//! copied. The parser reports where each Opus packet *is* — absolute file
//! offset and length — instead of handing out the bytes. The download path
//! feeds it the same buffer it is already writing to disk and keeps only the
//! offsets; the playback path runs it over an `mmap` and slices the packets out
//! of the mapping. Neither ever allocates per frame.
//!
//! Only the subset of EBML needed to reach the blocks is parsed. Every other
//! element is discarded by its declared size, so a large `Cues` or `Tags` costs
//! a counter decrement rather than memory.

use crate::ebml::{read_float, read_id, read_size, read_uint};
use crate::opus::{OpusHead, packet_info};

/// Cache line, on every target this runs on.
const LINE: usize = 64;

/// How far ahead of the cursor to keep lines requested.
///
/// The parser reads a few bytes of header and then jumps over a whole Opus
/// packet — about 370 bytes on a YouTube stream — so it touches roughly one
/// line in six. Hardware prefetchers key on sequential or fixed-stride access
/// and do not recognise that pattern, which leaves the whole walk waiting on
/// DRAM one header at a time. Requesting the next few lines by hand turns those
/// stalls into overlapped fetches. Half a kilobyte is enough to cover one skip
/// without evicting anything useful.
const PREFETCH_AHEAD: usize = 4096;

/// Below this, the buffer being parsed is small enough to sit in cache and the
/// hints cost more than the misses they would have hidden.
const PREFETCH_MIN_BUFFER: usize = 2 << 20;

/// Ask for a line to be brought toward L1 without waiting for it.
///
/// Both intrinsics are hints: an out-of-range address is not a fault, but the
/// callers bound them anyway rather than rely on that.
#[inline(always)]
fn prefetch_line(buf: &[u8], offset: usize) {
	if offset >= buf.len() {
		return;
	}
	// SAFETY: `offset` is in bounds, and both instructions are pure hints that
	// never fault and never write.
	unsafe {
		let ptr = buf.as_ptr().add(offset);
		#[cfg(target_arch = "aarch64")]
		std::arch::asm!("prfm pldl1keep, [{0}]", in(reg) ptr, options(nostack, readonly, preserves_flags));
		#[cfg(target_arch = "x86_64")]
		std::arch::x86_64::_mm_prefetch(ptr as *const i8, std::arch::x86_64::_MM_HINT_T0);
		#[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
		let _ = ptr;
	}
}

/// Element IDs, marker bit intact.
const ID_EBML: u64 = 0x1a45_dfa3;
const ID_SEGMENT: u64 = 0x1853_8067;
const ID_INFO: u64 = 0x1549_a966;
const ID_TIMESTAMP_SCALE: u64 = 0x002a_d7b1;
const ID_DURATION: u64 = 0x4489;
const ID_TRACKS: u64 = 0x1654_ae6b;
const ID_TRACK_ENTRY: u64 = 0xae;
const ID_TRACK_NUMBER: u64 = 0xd7;
const ID_CODEC_ID: u64 = 0x86;
const ID_CODEC_PRIVATE: u64 = 0x63a2;
const ID_CLUSTER: u64 = 0x1f43_b675;
const ID_TIMESTAMP: u64 = 0xe7;
const ID_BLOCK_GROUP: u64 = 0xa0;
const ID_SIMPLE_BLOCK: u64 = 0xa3;
const ID_BLOCK: u64 = 0xa1;

/// Descended into rather than skipped: their children are what we are after.
const fn is_master(id: u64) -> bool {
	matches!(id, ID_SEGMENT | ID_INFO | ID_TRACKS | ID_TRACK_ENTRY | ID_CLUSTER | ID_BLOCK_GROUP)
}

/// Buffered whole before being interpreted.
const fn is_leaf(id: u64) -> bool {
	matches!(
		id,
		ID_TIMESTAMP_SCALE
			| ID_DURATION | ID_TRACK_NUMBER
			| ID_CODEC_ID | ID_CODEC_PRIVATE
			| ID_TIMESTAMP | ID_SIMPLE_BLOCK
			| ID_BLOCK
	)
}

/// A leaf this parser cares about is a header field or a single audio block;
/// none legitimately reach a megabyte. The cap turns a corrupt size field into
/// an error instead of an allocation the process cannot survive.
const MAX_LEAF: u64 = 4 << 20;

/// Matroska's default when `Info` omits `TimestampScale`.
const DEFAULT_TIMESTAMP_SCALE_NS: u64 = 1_000_000;

#[derive(Debug, thiserror::Error)]
pub enum DemuxError {
	#[error("not a WebM stream: leading element 0x{0:x}")]
	NotWebm(u64),
	#[error("not a WebM stream: no EBML header")]
	NoHeader,
	#[error("element at {offset} declares an implausible size of {size} bytes")]
	LeafTooLarge { offset: u64, size: u64 },
}

/// Where one Opus packet sits in the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frame {
	/// Absolute byte offset of the packet within the source file.
	pub offset: u64,
	pub len: u32,
	/// Presentation time from the start of the stream.
	pub timestamp_ms: u32,
	/// Packet duration, read from the Opus TOC rather than the container.
	pub duration_us: u32,
}

#[derive(Debug, Clone, Copy)]
struct OpenMaster {
	id: u64,
	/// Absolute offset one past this element's last data byte. `u64::MAX` for
	/// an unknown-size master, which live-muxed WebM uses for `Segment`.
	end: u64,
}

#[derive(Debug)]
pub struct WebmDemuxer {
	/// Bytes of a partially received element, carried to the next `feed`.
	pending: Vec<u8>,
	/// Absolute file offset of `pending[0]`, or of the next byte to parse when
	/// `pending` is empty.
	absolute: u64,
	/// Bytes of an unwanted element still to be discarded.
	skipping: u64,
	stack: Vec<OpenMaster>,
	checked_header: bool,

	opus_track: Option<u64>,
	entry_track_number: Option<u64>,
	entry_codec: Option<Box<str>>,
	entry_codec_private: Option<OpusHead>,

	timestamp_scale_ns: u64,
	cluster_timestamp: u64,
	head: Option<OpusHead>,
	duration_ms: Option<u32>,
	frame_count: u64,
}

impl Default for WebmDemuxer {
	fn default() -> Self {
		Self::new()
	}
}

impl WebmDemuxer {
	pub fn new() -> Self {
		Self {
			pending: Vec::new(),
			absolute: 0,
			skipping: 0,
			stack: Vec::new(),
			checked_header: false,
			opus_track: None,
			entry_track_number: None,
			entry_codec: None,
			entry_codec_private: None,
			timestamp_scale_ns: DEFAULT_TIMESTAMP_SCALE_NS,
			cluster_timestamp: 0,
			head: None,
			duration_ms: None,
			frame_count: 0,
		}
	}

	/// The stream's `OpusHead`, once `Tracks` has gone by.
	pub fn head(&self) -> Option<OpusHead> {
		self.head
	}

	/// Duration declared by `Info`, if the muxer wrote one. Absent on a live
	/// or truncated file, where the only honest answer is the last frame seen.
	pub fn declared_duration_ms(&self) -> Option<u32> {
		self.duration_ms
	}

	pub fn frame_count(&self) -> u64 {
		self.frame_count
	}

	/// Feed the next contiguous chunk of the file. Chunks must arrive in order
	/// and without gaps; `sink` is called once per Opus packet, in order.
	pub fn feed<F: FnMut(Frame)>(&mut self, chunk: &[u8], sink: &mut F) -> Result<(), DemuxError> {
		if chunk.is_empty() {
			return Ok(());
		}

		// The common case is that the previous feed consumed everything, so the
		// chunk can be parsed where it lies and only its unparsed tail copied.
		if self.pending.is_empty() {
			let consumed = self.parse(chunk, sink)?;
			self.absolute += consumed as u64;
			self.pending.extend_from_slice(&chunk[consumed..]);
			return Ok(());
		}

		let mut buf = std::mem::take(&mut self.pending);
		buf.extend_from_slice(chunk);
		let consumed = self.parse(&buf, sink)?;
		self.absolute += consumed as u64;
		buf.drain(..consumed);
		self.pending = buf;
		Ok(())
	}

	/// Parse as much of `buf` as forms whole elements, returning bytes consumed.
	/// `buf[0]` sits at absolute offset `self.absolute`.
	fn parse<F: FnMut(Frame)>(&mut self, buf: &[u8], sink: &mut F) -> Result<usize, DemuxError> {
		// A non-Matroska source would otherwise parse as garbage and simply
		// yield no packets, which is indistinguishable from a track-less file.
		// Failing loudly lets the caller fall back to yt-dlp.
		if !self.checked_header {
			match read_id(buf, 0) {
				Some(id) if id.value == ID_EBML => self.checked_header = true,
				Some(id) => return Err(DemuxError::NotWebm(id.value)),
				// Four bytes is the widest an ID gets: past that, it is not one.
				None if buf.len() >= 4 => return Err(DemuxError::NoHeader),
				None => return Ok(0),
			}
		}

		let mut cursor = 0usize;
		// First offset not yet handed to the prefetcher. Kept outside the loop so
		// each line is requested once however many elements share it.
		let mut prefetched = 0usize;
		// Only worth it on a buffer too big to be in cache already. The download
		// path feeds network-sized chunks, which it re-copies into one reused
		// staging buffer that stays hot; there the hint instructions are pure
		// overhead — measured at half again the parse time.
		let prefetching = buf.len() >= PREFETCH_MIN_BUFFER;
		loop {
			// A skip can jump further than the window, in which case the lines in
			// between were never wanted and the window simply restarts.
			if prefetching {
				prefetched = prefetched.max(cursor);
				while prefetched < cursor + PREFETCH_AHEAD {
					prefetch_line(buf, prefetched);
					prefetched += LINE;
				}
			}

			if self.skipping > 0 {
				let take = self.skipping.min((buf.len() - cursor) as u64) as usize;
				cursor += take;
				self.skipping -= take as u64;
				// Ran out of data before the element ended.
				if self.skipping > 0 {
					break;
				}
			}

			let absolute = self.absolute + cursor as u64;
			while self.stack.last().is_some_and(|m| m.end <= absolute) {
				let master = self.stack.pop().expect("checked by is_some_and");
				self.close_master(master);
			}

			let Some(id) = read_id(buf, cursor) else { break };
			let Some(size) = read_size(buf, cursor + id.len) else { break };

			let header_len = id.len + size.len;
			let data_start = absolute + header_len as u64;

			if is_master(id.value) {
				self.stack.push(OpenMaster {
					id: id.value,
					end: if size.unknown {
						u64::MAX
					} else {
						data_start.saturating_add(size.value)
					},
				});
				if id.value == ID_TRACK_ENTRY {
					self.entry_track_number = None;
					self.entry_codec = None;
					self.entry_codec_private = None;
				}
				cursor += header_len;
				continue;
			}

			if is_leaf(id.value) {
				if size.value > MAX_LEAF {
					return Err(DemuxError::LeafTooLarge { offset: absolute, size: size.value });
				}
				let end = cursor + header_len + size.value as usize;
				// Leaves are interpreted whole, so wait for the rest of it.
				if end > buf.len() {
					break;
				}
				self.handle_leaf(id.value, &buf[cursor + header_len..end], data_start, sink);
				cursor = end;
				continue;
			}

			// Unwanted: drop its payload, possibly across several chunks.
			cursor += header_len;
			self.skipping = if size.unknown { 0 } else { size.value };
		}

		Ok(cursor)
	}

	fn close_master(&mut self, master: OpenMaster) {
		if master.id != ID_TRACK_ENTRY || self.opus_track.is_some() {
			return;
		}
		let Some(number) = self.entry_track_number else { return };
		// CodecID is a zero-padded ASCII string.
		let codec = self.entry_codec.as_deref().unwrap_or("");
		if !codec.trim_end_matches('\0').starts_with("A_OPUS") {
			return;
		}
		self.opus_track = Some(number);
		self.head = self.entry_codec_private;
	}

	fn handle_leaf<F: FnMut(Frame)>(&mut self, id: u64, data: &[u8], data_start: u64, sink: &mut F) {
		match id {
			ID_TRACK_NUMBER => self.entry_track_number = Some(read_uint(data)),
			ID_CODEC_ID => {
				self.entry_codec = Some(String::from_utf8_lossy(data).into_owned().into_boxed_str())
			}
			ID_CODEC_PRIVATE => self.entry_codec_private = OpusHead::parse(data),
			ID_TIMESTAMP_SCALE => {
				let scale = read_uint(data);
				// A zero scale would turn every timestamp into zero; keep the
				// default rather than propagate nonsense.
				if scale > 0 {
					self.timestamp_scale_ns = scale;
				}
			}
			ID_DURATION => {
				if let Some(ticks) = read_float(data) {
					let ms = ticks * self.timestamp_scale_ns as f64 / 1_000_000.0;
					if ms.is_finite() && ms >= 0.0 {
						self.duration_ms = Some(ms as u32);
					}
				}
			}
			ID_TIMESTAMP => {
				// Only clusters carry a timestamp the blocks are relative to.
				if self.stack.last().is_some_and(|m| m.id == ID_CLUSTER) {
					self.cluster_timestamp = read_uint(data);
				}
			}
			ID_SIMPLE_BLOCK | ID_BLOCK => self.emit_block(data, data_start, sink),
			_ => {}
		}
	}

	/// Split one block into its frames and report each one's position.
	///
	/// `data_start` is the absolute offset of `data[0]`, so every frame offset
	/// handed to `sink` points straight into the file.
	fn emit_block<F: FnMut(Frame)>(&mut self, data: &[u8], data_start: u64, sink: &mut F) {
		let Some(track) = self.opus_track else { return };
		let Some(number) = read_size(data, 0) else { return };
		if number.value != track {
			return;
		}

		// track VINT, then an int16 timecode relative to the cluster, then flags
		let flags_offset = number.len + 2;
		let Some(&flags) = data.get(flags_offset) else { return };
		let relative =
			i16::from_be_bytes([data[number.len], data[number.len + 1]]) as i64;
		let block_ticks = self.cluster_timestamp as i64 + relative;
		let block_ms = (block_ticks.max(0) as u64 * self.timestamp_scale_ns / 1_000_000) as u32;

		let lacing = (flags >> 1) & 0x03;
		let mut cursor = flags_offset + 1;

		if lacing == 0 {
			self.push_frame(data, cursor, data.len(), data_start, block_ms, sink);
			return;
		}

		let Some(&count_byte) = data.get(cursor) else { return };
		let frames = count_byte as usize + 1;
		cursor += 1;

		let mut sizes: Vec<usize> = Vec::with_capacity(frames);
		match lacing {
			// Fixed: every frame is the same width.
			2 => {
				let total = data.len() - cursor;
				if !total.is_multiple_of(frames) {
					return;
				}
				sizes.resize(frames, total / frames);
			}
			// Xiph: 255-terminated byte runs, one run per frame but the last.
			1 => {
				for _ in 0..frames - 1 {
					let mut size = 0usize;
					loop {
						let Some(&byte) = data.get(cursor) else { return };
						cursor += 1;
						size += byte as usize;
						if byte != 0xff {
							break;
						}
					}
					sizes.push(size);
				}
			}
			// EBML: an unsigned VINT, then signed VINT deltas against it.
			_ => {
				let Some(first) = read_size(data, cursor) else { return };
				cursor += first.len;
				sizes.push(first.value as usize);
				for _ in 1..frames.saturating_sub(1) {
					let Some(delta) = read_size(data, cursor) else { return };
					cursor += delta.len;
					// Signed VINTs are biased by half their value range.
					let bias = (1i64 << (7 * delta.len - 1)) - 1;
					let previous = *sizes.last().expect("seeded above") as i64;
					let size = previous + delta.value as i64 - bias;
					if size < 0 {
						return;
					}
					sizes.push(size as usize);
				}
			}
		}

		// Every lacing but fixed leaves the final frame's size implicit.
		if lacing != 2 {
			let used: usize = sizes.iter().sum();
			let Some(remaining) = data.len().checked_sub(cursor + used) else { return };
			sizes.push(remaining);
		}

		// Matroska times the block, not the frames inside it, so each laced
		// frame is placed by accumulating the durations the TOC bytes declare.
		let mut offset_us = 0u32;
		for size in sizes {
			let Some(end) = cursor.checked_add(size).filter(|end| *end <= data.len()) else {
				return;
			};
			let duration = self.push_frame(
				data,
				cursor,
				end,
				data_start,
				block_ms + offset_us / 1000,
				sink,
			);
			offset_us += duration;
			cursor = end;
		}
	}

	/// Report one frame, returning its duration so laced frames can be timed.
	fn push_frame<F: FnMut(Frame)>(
		&mut self,
		data: &[u8],
		start: usize,
		end: usize,
		data_start: u64,
		timestamp_ms: u32,
		sink: &mut F,
	) -> u32 {
		let packet = &data[start..end];
		// A zero-length frame carries no audio and has no TOC to time it by.
		let Some(info) = packet_info(packet) else { return 0 };
		self.frame_count += 1;
		sink(Frame {
			offset: data_start + start as u64,
			len: packet.len() as u32,
			timestamp_ms,
			duration_us: info.duration_us,
		});
		info.duration_us
	}
}
