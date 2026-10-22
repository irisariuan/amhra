//! A track arriving over the network instead of from the cache.
//!
//! The fetcher normally writes `<id>.temp.music` and the reader follows that
//! file as it grows. With caching off there is no file: the downloader hands
//! each chunk straight to the reader through this channel, and the reader keeps
//! the track in memory for exactly as long as it is loaded. Everything played
//! stays, so the track can still seek back; the moment the reader is dropped —
//! the track finished, skipped, replaced or stopped — all of it is freed.
//!
//! A channel rather than a shared buffer, so the audio thread never takes a
//! lock: picking up new bytes is a `try_recv` loop. The channel also carries
//! cancellation the other way. A reader dropped mid-download closes it, the
//! next `push` fails, and the download stops paying for audio nobody will hear.

use std::sync::mpsc::{Receiver, Sender, TryRecvError};

/// One message from the downloader.
#[derive(Debug)]
enum Piece {
	/// The whole track's size, once known, so the buffer is allocated once
	/// rather than regrown — and recopied — as the track arrives.
	Expect(u64),
	Bytes(Vec<u8>),
}

/// The downloader's half. Dropping it ends the stream, finished or not: a
/// failed download has nothing more to say than that no more bytes are coming,
/// and the track then ends where its audio does.
#[derive(Debug)]
pub struct StreamWriter {
	sender: Sender<Piece>,
	sent: u64,
}

/// The reader's half, consumed by [`crate::CacheReader::streaming`].
#[derive(Debug)]
pub struct StreamFeed {
	receiver: Receiver<Piece>,
}

/// What a feed has for the reader right now.
#[derive(Debug)]
pub(crate) enum Arrival {
	Expect(u64),
	Bytes(Vec<u8>),
	/// Nothing yet; more may come.
	Waiting,
	/// No more bytes will ever come.
	Ended,
}

/// A connected writer and feed.
pub fn channel() -> (StreamWriter, StreamFeed) {
	let (sender, receiver) = std::sync::mpsc::channel();
	(StreamWriter { sender, sent: 0 }, StreamFeed { receiver })
}

impl StreamWriter {
	/// Say how large the track is. Only a sizing hint.
	pub fn expect(&self, total: u64) {
		let _ = self.sender.send(Piece::Expect(total));
	}

	/// Hand over the next contiguous bytes. False once the reader is gone,
	/// which is the downloader's signal to stop.
	pub fn push(&mut self, bytes: &[u8]) -> bool {
		if self.sender.send(Piece::Bytes(bytes.to_vec())).is_err() {
			return false;
		}
		self.sent += bytes.len() as u64;
		true
	}

	/// Bytes pushed so far: where a download resumed elsewhere must pick up.
	pub fn sent(&self) -> u64 {
		self.sent
	}
}

impl StreamFeed {
	pub(crate) fn poll(&self) -> Arrival {
		match self.receiver.try_recv() {
			Ok(Piece::Expect(total)) => Arrival::Expect(total),
			Ok(Piece::Bytes(bytes)) => Arrival::Bytes(bytes),
			Err(TryRecvError::Empty) => Arrival::Waiting,
			Err(TryRecvError::Disconnected) => Arrival::Ended,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn bytes_arrive_in_order_and_the_end_is_the_writer_going() {
		let (mut writer, feed) = channel();
		writer.expect(6);
		assert!(writer.push(&[1, 2, 3]));
		assert!(writer.push(&[4, 5, 6]));
		assert_eq!(writer.sent(), 6);

		assert!(matches!(feed.poll(), Arrival::Expect(6)));
		assert!(matches!(feed.poll(), Arrival::Bytes(bytes) if bytes == [1, 2, 3]));
		assert!(matches!(feed.poll(), Arrival::Bytes(bytes) if bytes == [4, 5, 6]));
		assert!(matches!(feed.poll(), Arrival::Waiting));

		drop(writer);
		assert!(matches!(feed.poll(), Arrival::Ended));
	}

	#[test]
	fn dropping_the_feed_tells_the_writer_to_stop() {
		let (mut writer, feed) = channel();
		drop(feed);
		assert!(!writer.push(&[0; 16]));
		assert_eq!(writer.sent(), 0, "bytes nobody received were not sent");
	}
}
