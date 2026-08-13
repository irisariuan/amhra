//! The slice of EBML needed to walk a Matroska file: variable-width integers.
//!
//! Both element IDs and element sizes are stored as VINTs. They differ only in
//! what happens to the marker bit — an ID keeps it (the marker is part of the
//! identity), a size strips it (the marker only encodes the width).

/// Total byte width of a VINT from its first byte: one more than the number of
/// leading zero bits. Zero means the byte cannot start a VINT.
#[inline]
pub const fn vint_len(first: u8) -> usize {
	// leading_zeros() on a u8 promoted to u32 counts 24 phantom bits first.
	if first == 0 { 0 } else { first.leading_zeros() as usize + 1 }
}

#[derive(Debug, Clone, Copy)]
pub struct Vint {
	pub value: u64,
	pub len: usize,
	/// Every value bit set. For a size this means "unknown length", which
	/// Matroska allows on master elements that are written before their
	/// contents are known — live-muxed WebM uses it for Segment.
	pub unknown: bool,
}

/// Element ID, marker bit intact.
///
/// Returns `None` when the buffer is too short to hold the whole ID, or when
/// the width exceeds four bytes — no valid ID is wider than that, so a wider
/// VINT means the cursor is not element-aligned and the caller is parsing
/// garbage.
#[inline]
pub fn read_id(buf: &[u8], offset: usize) -> Option<Vint> {
	let first = *buf.get(offset)?;
	let len = vint_len(first);
	if len == 0 || len > 4 || offset + len > buf.len() {
		return None;
	}
	let mut value = 0u64;
	for &byte in &buf[offset..offset + len] {
		value = (value << 8) | byte as u64;
	}
	Some(Vint { value, len, unknown: false })
}

/// Element size, marker bit stripped.
#[inline]
pub fn read_size(buf: &[u8], offset: usize) -> Option<Vint> {
	let first = *buf.get(offset)?;
	let len = vint_len(first);
	// Sizes may be up to 8 bytes; wider is not representable.
	if len == 0 || len > 8 || offset + len > buf.len() {
		return None;
	}
	// An 8-byte VINT spends its whole first byte on the marker, leaving no
	// value bits there — and `0xff >> 8` is an overflow, not a zero.
	let mask = 0xffu8.checked_shr(len as u32).unwrap_or(0);
	let mut value = (first & mask) as u64;
	let mut unknown = value == mask as u64;
	for &byte in &buf[offset + 1..offset + len] {
		value = (value << 8) | byte as u64;
		if byte != 0xff {
			unknown = false;
		}
	}
	Some(Vint { value, len, unknown })
}

/// Unsigned EBML integer of any width, as stored in TrackNumber or Timestamp.
///
/// Widths above 8 bytes cannot occur in a well-formed file; the fold simply
/// keeps the low 64 bits rather than failing, since the caller has already
/// bounded the element by its declared size.
#[inline]
pub fn read_uint(data: &[u8]) -> u64 {
	data.iter().fold(0u64, |acc, &b| (acc << 8) | b as u64)
}

/// EBML float: 4 or 8 bytes, big-endian IEEE-754. Any other width is invalid.
#[inline]
pub fn read_float(data: &[u8]) -> Option<f64> {
	match data.len() {
		4 => Some(f32::from_be_bytes(data.try_into().ok()?) as f64),
		8 => Some(f64::from_be_bytes(data.try_into().ok()?)),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn vint_widths() {
		assert_eq!(vint_len(0x82), 1);
		assert_eq!(vint_len(0x40), 2);
		assert_eq!(vint_len(0x1f), 4);
		assert_eq!(vint_len(0x01), 8);
		assert_eq!(vint_len(0x00), 0);
	}

	#[test]
	fn ids_keep_their_marker() {
		// Segment
		let buf = [0x18, 0x53, 0x80, 0x67];
		let id = read_id(&buf, 0).unwrap();
		assert_eq!(id.value, 0x1853_8067);
		assert_eq!(id.len, 4);
	}

	#[test]
	fn sizes_drop_their_marker() {
		// 0x81 -> 1 byte wide, value 1
		let size = read_size(&[0x81], 0).unwrap();
		assert_eq!(size.value, 1);
		assert!(!size.unknown);

		// 0x41 0x23 -> 2 bytes wide, value 0x123
		let size = read_size(&[0x41, 0x23], 0).unwrap();
		assert_eq!(size.value, 0x123);
		assert_eq!(size.len, 2);
	}

	#[test]
	fn all_value_bits_set_means_unknown() {
		assert!(read_size(&[0xff], 0).unwrap().unknown);
		assert!(read_size(&[0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0).unwrap().unknown);
		assert!(!read_size(&[0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe], 0).unwrap().unknown);
	}

	#[test]
	fn truncated_input_is_not_a_parse() {
		assert!(read_id(&[0x18, 0x53], 0).is_none());
		assert!(read_size(&[0x41], 0).is_none());
		assert!(read_id(&[], 0).is_none());
	}
}
