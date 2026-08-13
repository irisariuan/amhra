//! The MLS key-schedule derivations DAVE's sender keys need.
//!
//! These are RFC 9420's `ExpandWithLabel` and `DeriveTreeSecret`, but following
//! MLS++'s implementation rather than a strict reading of the RFC: MLS++
//! resizes the HKDF output instead of rejecting a length that does not match
//! the hash, and DAVE relies on that — the sender base secret is 16 bytes while
//! the derivations ask for 12, 16 and 32. A conformant HKDF refuses that
//! combination outright, so the loop below is written out rather than taken
//! from `hkdf`.

use hmac::{Hmac, Mac};
use sha2::Sha256;

#[derive(Debug, thiserror::Error)]
#[error("invalid key derivation length")]
pub struct InvalidLength;

/// MLS's variable-length byte vector: a QUIC-style length prefix, then bytes.
///
/// The prefix's top two bits encode its own width, so lengths below 64 cost one
/// byte. Only the first three widths are reachable here.
fn write_vl_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
	let length = bytes.len();
	if length < 0x40 {
		out.push(length as u8);
	} else if length < 0x4000 {
		out.extend_from_slice(&((length as u16) | 0x4000).to_be_bytes());
	} else {
		out.extend_from_slice(&((length as u32) | 0x8000_0000).to_be_bytes());
	}
	out.extend_from_slice(bytes);
}

/// MLS++'s HKDF-Expand: HMAC-SHA256 in counter mode, truncated to `size`.
fn hkdf_expand(prk: &[u8], info: &[u8], size: usize) -> Result<Vec<u8>, InvalidLength> {
	let mut okm: Vec<u8> = Vec::with_capacity(size + 32);
	let mut previous: Vec<u8> = Vec::new();
	let mut counter: u8 = 0;

	while okm.len() < size {
		counter = counter.checked_add(1).ok_or(InvalidLength)?;
		let mut mac = Hmac::<Sha256>::new_from_slice(prk).map_err(|_| InvalidLength)?;
		mac.update(&previous);
		mac.update(info);
		mac.update(&[counter]);
		previous = mac.finalize().into_bytes().to_vec();
		okm.extend_from_slice(&previous);
	}

	okm.truncate(size);
	Ok(okm)
}

/// `ExpandWithLabel(secret, label, context, length)` with MLS 1.0's prefix.
fn expand_with_label(
	secret: &[u8],
	label: &str,
	context: &[u8],
	length: usize,
) -> Result<Vec<u8>, InvalidLength> {
	let mls_label = format!("MLS 1.0 {label}");
	// KDFLabel { uint16 length; opaque label<V>; opaque context<V>; }
	let mut info = Vec::with_capacity(mls_label.len() + context.len() + 8);
	info.extend_from_slice(&(length as u16).to_be_bytes());
	write_vl_bytes(&mut info, mls_label.as_bytes());
	write_vl_bytes(&mut info, context);
	hkdf_expand(secret, &info, length)
}

/// `DeriveTreeSecret(secret, label, generation, length)`.
pub fn derive_tree_secret(
	secret: &[u8],
	label: &str,
	generation: u32,
	length: usize,
) -> Result<Vec<u8>, InvalidLength> {
	expand_with_label(secret, label, &generation.to_be_bytes(), length)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn short_vectors_use_a_one_byte_prefix() {
		let mut out = Vec::new();
		write_vl_bytes(&mut out, b"abc");
		assert_eq!(out, vec![3, b'a', b'b', b'c']);
	}

	#[test]
	fn longer_vectors_widen_the_prefix() {
		let mut out = Vec::new();
		write_vl_bytes(&mut out, &[0u8; 100]);
		// 100 fits in 14 bits, so the prefix is two bytes tagged 0b01.
		assert_eq!(out[0], 0x40);
		assert_eq!(out[1], 100);
		assert_eq!(out.len(), 102);
	}

	/// The output must be exactly `size`, even when that is not a multiple of
	/// the hash length — the case a conformant HKDF would refuse.
	#[test]
	fn expansion_resizes_rather_than_refusing() {
		let secret = [7u8; 16];
		assert_eq!(hkdf_expand(&secret, b"info", 12).unwrap().len(), 12);
		assert_eq!(hkdf_expand(&secret, b"info", 16).unwrap().len(), 16);
		assert_eq!(hkdf_expand(&secret, b"info", 32).unwrap().len(), 32);
		assert_eq!(hkdf_expand(&secret, b"info", 100).unwrap().len(), 100);
	}

	#[test]
	fn derivations_are_domain_separated() {
		let secret = [1u8; 16];
		let key = derive_tree_secret(&secret, "key", 0, 16).unwrap();
		let nonce = derive_tree_secret(&secret, "nonce", 0, 16).unwrap();
		let next = derive_tree_secret(&secret, "key", 1, 16).unwrap();
		assert_ne!(key, nonce, "label must change the output");
		assert_ne!(key, next, "generation must change the output");
	}
}
