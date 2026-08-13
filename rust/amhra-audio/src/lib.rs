//! Audio plumbing shared by the fetcher and the player.
//!
//! Everything here is deliberately allocation-light and copy-free: the
//! demuxer reports offsets instead of bytes, the index is memory-mapped, and
//! nothing in the hot path owns a buffer it did not need to own.

pub mod ebml;
pub mod index;
pub mod opus;
pub mod webm;

pub use index::{Entry, Index, IndexError, IndexWriter};
pub use opus::{OpusHead, PacketInfo, packet_info};
pub use webm::{DemuxError, Frame, WebmDemuxer};

use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum Error {
	#[error(transparent)]
	Demux(#[from] DemuxError),
	#[error(transparent)]
	Index(#[from] IndexError),
}

/// What an indexing run produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexSummary {
	pub frames: u64,
	pub duration_ms: u32,
	pub channels: u8,
}

/// Demuxes a WebM/Opus stream as it arrives and writes its `.idx` sidecar.
///
/// The downloader already holds every byte on its way to disk, so indexing
/// costs one pass over a buffer that is in cache anyway — no second read, no
/// second process, and the index is complete the moment the download is.
#[derive(Debug)]
pub struct CacheIndexer {
	demuxer: WebmDemuxer,
	writer: IndexWriter,
	head_recorded: bool,
}

impl CacheIndexer {
	pub fn create(index_path: &Path) -> Result<Self, Error> {
		Self::with_interval(index_path, index::DEFAULT_INTERVAL_MS)
	}

	pub fn with_interval(index_path: &Path, interval_ms: u16) -> Result<Self, Error> {
		Ok(Self {
			demuxer: WebmDemuxer::new(),
			writer: IndexWriter::create(index_path, interval_ms)?,
			head_recorded: false,
		})
	}

	/// Feed the next contiguous chunk of the download.
	pub fn feed(&mut self, chunk: &[u8]) -> Result<(), Error> {
		// Split the borrow so the sink can write entries while the demuxer runs.
		let Self { demuxer, writer, .. } = self;
		let mut failure: Option<IndexError> = None;
		demuxer.feed(chunk, &mut |frame| {
			if failure.is_none()
				&& let Err(error) = writer.observe(&frame)
			{
				failure = Some(error);
			}
		})?;
		if let Some(error) = failure {
			return Err(error.into());
		}

		// `Tracks` precedes the first cluster, so this lands before any entry
		// the reader could care about, but only once the head actually exists.
		if !self.head_recorded
			&& let Some(head) = self.demuxer.head()
		{
			self.writer.set_head(head)?;
			self.head_recorded = true;
		}
		Ok(())
	}

	/// Close the index out. Call only after the last byte has been fed.
	pub fn finish(mut self) -> Result<IndexSummary, Error> {
		let declared = self.demuxer.declared_duration_ms();
		self.writer.finalize(declared)?;
		Ok(IndexSummary {
			frames: self.demuxer.frame_count(),
			duration_ms: declared.unwrap_or_default(),
			channels: self.demuxer.head().map_or(0, |head| head.channels),
		})
	}
}
