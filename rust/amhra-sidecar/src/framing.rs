//! Length-prefixed frames over a pipe.
//!
//! `u32` big-endian length, then that many bytes of JSON. A pipe carries no
//! message boundaries, and newline framing would break on the first track title
//! containing one — which is a bug that appears in production and never in
//! tests.

use std::io::{Read, Write};

use crate::protocol::MAX_FRAME_LEN;

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
	#[error("i/o: {0}")]
	Io(#[from] std::io::Error),
	#[error("frame of {0} bytes exceeds the {MAX_FRAME_LEN} byte limit")]
	TooLarge(u32),
	#[error("json: {0}")]
	Json(#[from] serde_json::Error),
}

impl FrameError {
	/// Whether this ended the stream rather than damaged it.
	pub fn is_eof(&self) -> bool {
		matches!(self, Self::Io(error) if error.kind() == std::io::ErrorKind::UnexpectedEof)
	}
}

/// Read one frame and deserialise it.
pub fn read_frame<T: serde::de::DeserializeOwned>(
	reader: &mut impl Read,
	buffer: &mut Vec<u8>,
) -> Result<T, FrameError> {
	let mut length = [0u8; 4];
	reader.read_exact(&mut length)?;
	let length = u32::from_be_bytes(length);
	// A desynchronised stream produces enormous lengths; refusing beats
	// allocating whatever the noise happened to say.
	if length > MAX_FRAME_LEN {
		return Err(FrameError::TooLarge(length));
	}

	buffer.clear();
	buffer.resize(length as usize, 0);
	reader.read_exact(buffer)?;
	Ok(serde_json::from_slice(buffer)?)
}

/// Serialise and write one frame.
pub fn write_frame<T: serde::Serialize>(
	writer: &mut impl Write,
	value: &T,
) -> Result<(), FrameError> {
	let payload = serde_json::to_vec(value)?;
	let length = u32::try_from(payload.len()).map_err(|_| FrameError::TooLarge(u32::MAX))?;
	if length > MAX_FRAME_LEN {
		return Err(FrameError::TooLarge(length));
	}
	// One write for the header and one for the body would let a reader see a
	// half-frame if the process died between them; the vector is small enough
	// that joining them costs nothing.
	let mut framed = Vec::with_capacity(4 + payload.len());
	framed.extend_from_slice(&length.to_be_bytes());
	framed.extend_from_slice(&payload);
	writer.write_all(&framed)?;
	writer.flush()?;
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::protocol::{Command, Event};

	#[test]
	fn a_frame_round_trips() {
		let command = Command::Skip { guild_id: "42".to_owned() };
		let mut pipe = Vec::new();
		write_frame(&mut pipe, &command).unwrap();

		let mut buffer = Vec::new();
		let decoded: Command = read_frame(&mut pipe.as_slice(), &mut buffer).unwrap();
		assert!(matches!(decoded, Command::Skip { guild_id } if guild_id == "42"));
	}

	#[test]
	fn several_frames_are_separated_correctly() {
		let mut pipe = Vec::new();
		for id in 0..5 {
			write_frame(&mut pipe, &Event::Idle { guild_id: id.to_string() }).unwrap();
		}

		let mut reader = pipe.as_slice();
		let mut buffer = Vec::new();
		for id in 0..5 {
			let event: Event = read_frame(&mut reader, &mut buffer).unwrap();
			assert!(matches!(event, Event::Idle { guild_id } if guild_id == id.to_string()));
		}
		// And the stream is exhausted, not left with trailing bytes.
		assert!(read_frame::<Event>(&mut reader, &mut buffer).unwrap_err().is_eof());
	}

	#[test]
	fn newlines_in_content_do_not_break_framing() {
		// The reason for length prefixes rather than lines.
		let event = Event::Error {
			guild_id: None,
			message: "line one\nline two\r\nline three".to_owned(),
		};
		let mut pipe = Vec::new();
		write_frame(&mut pipe, &event).unwrap();

		let mut buffer = Vec::new();
		let decoded: Event = read_frame(&mut pipe.as_slice(), &mut buffer).unwrap();
		let Event::Error { message, .. } = decoded else { panic!("wrong variant") };
		assert_eq!(message, "line one\nline two\r\nline three");
	}

	#[test]
	fn an_absurd_length_is_refused_rather_than_allocated() {
		let mut pipe = Vec::new();
		pipe.extend_from_slice(&u32::MAX.to_be_bytes());
		pipe.extend_from_slice(b"{}");

		let mut buffer = Vec::new();
		let error = read_frame::<Event>(&mut pipe.as_slice(), &mut buffer).unwrap_err();
		assert!(matches!(error, FrameError::TooLarge(_)));
	}

	#[test]
	fn a_truncated_frame_is_an_eof_not_a_parse_error() {
		let mut pipe = Vec::new();
		write_frame(&mut pipe, &Event::Idle { guild_id: "1".to_owned() }).unwrap();
		pipe.truncate(pipe.len() - 3);

		let mut buffer = Vec::new();
		let error = read_frame::<Event>(&mut pipe.as_slice(), &mut buffer).unwrap_err();
		assert!(error.is_eof(), "expected eof, got {error}");
	}

	#[test]
	fn malformed_json_is_reported_as_json_not_as_eof() {
		let mut pipe = Vec::new();
		pipe.extend_from_slice(&5u32.to_be_bytes());
		pipe.extend_from_slice(b"{not}");

		let mut buffer = Vec::new();
		let error = read_frame::<Event>(&mut pipe.as_slice(), &mut buffer).unwrap_err();
		assert!(matches!(error, FrameError::Json(_)));
		assert!(!error.is_eof());
	}
}
