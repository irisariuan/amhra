//! DAVE frame encryption — the layer between the Opus encoder and the RTP
//! packet.
//!
//! An encrypted frame is laid out so a receiver can parse it backwards from the
//! end, because the ciphertext length is not known in advance:
//!
//! ```text
//! [ ciphertext ][ tag, 8 ][ nonce, LEB128 ][ ranges ][ size, 1 ][ 0xFA 0xFA ]
//! ```
//!
//! Opus is the easy case: every byte of an Opus packet is payload, so there are
//! no unencrypted ranges and the additional authenticated data is empty. Codecs
//! whose packetizers must read headers leave those ranges in the clear; this
//! sender never produces them.
//!
//! The GCM tag is truncated from 16 bytes to 8. That is DAVE's choice, not
//! ours: the frames are already inside the transport-encrypted RTP packet, and
//! 8 bytes of overhead per 20ms frame is 3.2kbit/s that would otherwise be
//! spent twice.

use aes_gcm::aead::AeadInPlace;
use aes_gcm::{Aes128Gcm, KeyInit, Nonce};

use super::ratchet::{HashRatchet, RatchetError};

/// Marks a frame as DAVE-encrypted.
pub const MARKER: [u8; 2] = [0xFA, 0xFA];
/// The GCM tag is truncated to this many bytes on the wire.
pub const TRUNCATED_TAG_LEN: usize = 8;
/// Bytes of the 32-bit frame nonce that ride in the AES-GCM nonce.
const SYNC_NONCE_LEN: usize = 4;
/// Where they sit in it: the 8 most significant bytes stay zero.
const SYNC_NONCE_OFFSET: usize = 12 - SYNC_NONCE_LEN;
/// The generation occupies the top byte of the 32-bit frame nonce.
const GENERATION_SHIFT: u32 = 8 * (SYNC_NONCE_LEN as u32 - 1);
/// Fixed part of the trailer: tag, the size byte, and the marker.
const SUPPLEMENTAL_BYTES: usize = TRUNCATED_TAG_LEN + 1 + MARKER.len();

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
	#[error("ratchet: {0}")]
	Ratchet(#[from] RatchetError),
	#[error("frame encryption failed")]
	Encrypt,
	#[error("frame nonce exhausted; the epoch must advance")]
	NonceExhausted,
}

/// LEB128 length of `value`.
pub fn leb128_size(mut value: u32) -> usize {
	let mut size = 1;
	while value >= 0x80 {
		size += 1;
		value >>= 7;
	}
	size
}

/// Append `value` as LEB128.
pub fn write_leb128(value: u32, out: &mut Vec<u8>) {
	let mut value = value;
	while value >= 0x80 {
		out.push(0x80 | (value & 0x7f) as u8);
		value >>= 7;
	}
	out.push(value as u8);
}

/// Encrypts outbound Opus frames for one sender.
pub struct Encryptor {
	ratchet: HashRatchet,
	nonce: u32,
}

impl std::fmt::Debug for Encryptor {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Encryptor")
			.field("nonce", &self.nonce)
			.field("generation", &(self.nonce >> GENERATION_SHIFT))
			.finish_non_exhaustive()
	}
}

impl Encryptor {
	/// Start from a sender base secret exported from the MLS group.
	pub fn new(base_secret: Vec<u8>) -> Self {
		Self { ratchet: HashRatchet::new(base_secret), nonce: 0 }
	}

	/// Replace the key material after an epoch change, restarting the nonce.
	pub fn set_base_secret(&mut self, base_secret: Vec<u8>) {
		self.ratchet = HashRatchet::new(base_secret);
		self.nonce = 0;
	}

	/// The generation currently being sent under.
	pub fn generation(&self) -> u32 {
		self.nonce >> GENERATION_SHIFT
	}

	/// Encrypt one Opus packet, writing the DAVE frame into `out`.
	///
	/// `out` is cleared first and ends up `frame.len() + overhead` long, where
	/// the overhead is 11 bytes plus the LEB128 nonce — 12 bytes for the first
	/// 16k frames of an epoch, 13 after that.
	pub fn encrypt_opus(&mut self, frame: &[u8], out: &mut Vec<u8>) -> Result<(), FrameError> {
		// The nonce carries the generation in its top byte, so running out of
		// nonces means running out of generations: the epoch has to change.
		let nonce_value = self.nonce;
		self.nonce = self.nonce.checked_add(1).ok_or(FrameError::NonceExhausted)?;

		let generation = nonce_value >> GENERATION_SHIFT;
		let material = self.ratchet.get(generation)?;

		// The ratchet's own nonce is unused for the sync-nonce construction:
		// the AES-GCM nonce is the 32-bit frame nonce, little-endian, in the
		// last four bytes of an otherwise zero buffer.
		let mut nonce_buffer = [0u8; 12];
		nonce_buffer[SYNC_NONCE_OFFSET..].copy_from_slice(&nonce_value.to_le_bytes());

		let cipher =
			Aes128Gcm::new_from_slice(&material.key).map_err(|_| FrameError::Encrypt)?;

		out.clear();
		out.reserve(frame.len() + SUPPLEMENTAL_BYTES + leb128_size(nonce_value));
		out.extend_from_slice(frame);

		// Opus frames are encrypted whole, so there is no additional
		// authenticated data and no unencrypted ranges to serialise.
		let tag = cipher
			.encrypt_in_place_detached(Nonce::from_slice(&nonce_buffer), &[], out.as_mut_slice())
			.map_err(|_| FrameError::Encrypt)?;

		out.extend_from_slice(&tag[..TRUNCATED_TAG_LEN]);
		let nonce_size = leb128_size(nonce_value);
		write_leb128(nonce_value, out);
		// No unencrypted ranges for Opus: the field is present but empty.
		let supplemental = SUPPLEMENTAL_BYTES + nonce_size;
		debug_assert!(supplemental <= u8::MAX as usize);
		out.push(supplemental as u8);
		out.extend_from_slice(&MARKER);
		Ok(())
	}
}

/// Whether a frame carries DAVE's marker, for a receiver or a test.
pub fn is_encrypted_frame(frame: &[u8]) -> bool {
	frame.len() > SUPPLEMENTAL_BYTES && frame[frame.len() - 2..] == MARKER
}

#[cfg(test)]
mod tests {
	use super::*;
	use aes_gcm::aead::Aead;
	use aes_gcm::aead::Payload;

	fn encryptor() -> Encryptor {
		Encryptor::new(vec![206, 221, 97, 177, 184, 161, 202, 105, 4, 101, 84, 40, 44, 247, 11, 123])
	}

	#[test]
	fn leb128_matches_the_reference_sizes() {
		assert_eq!(leb128_size(0), 1);
		assert_eq!(leb128_size(127), 1);
		assert_eq!(leb128_size(128), 2);
		assert_eq!(leb128_size(16_383), 2);
		assert_eq!(leb128_size(16_384), 3);
		assert_eq!(leb128_size(u32::MAX), 5);

		let mut out = Vec::new();
		write_leb128(300, &mut out);
		assert_eq!(out, vec![0xac, 0x02]);
		assert_eq!(out.len(), leb128_size(300));
	}

	#[test]
	fn frame_layout_ends_with_size_and_marker() {
		let mut out = Vec::new();
		encryptor().encrypt_opus(&[0xfc; 40], &mut out).unwrap();

		assert_eq!(out[out.len() - 2..], MARKER);
		let supplemental = out[out.len() - 3] as usize;
		// tag(8) + size(1) + marker(2) + leb128(nonce 0 -> 1 byte)
		assert_eq!(supplemental, 12);
		assert_eq!(out.len(), 40 + 12);
		assert!(is_encrypted_frame(&out));
	}

	#[test]
	fn the_ciphertext_decrypts_with_the_documented_nonce() {
		let mut encryptor = encryptor();
		let plaintext = [0xfc, 0x11, 0x22, 0x33, 0x44];
		let mut out = Vec::new();
		encryptor.encrypt_opus(&plaintext, &mut out).unwrap();

		// A receiver reads the nonce from the trailer and rebuilds the key from
		// its own copy of the ratchet.
		let nonce_value = out[plaintext.len() + TRUNCATED_TAG_LEN] as u32;
		assert_eq!(nonce_value, 0);
		let mut ratchet = HashRatchet::new(vec![
			206, 221, 97, 177, 184, 161, 202, 105, 4, 101, 84, 40, 44, 247, 11, 123,
		]);
		let material = ratchet.get(0).unwrap();

		let mut nonce_buffer = [0u8; 12];
		nonce_buffer[8..].copy_from_slice(&nonce_value.to_le_bytes());

		// The tag is truncated on the wire, so a full-tag decrypt cannot be used
		// directly; re-encrypt and compare instead.
		let cipher = Aes128Gcm::new_from_slice(&material.key).unwrap();
		let full = cipher
			.encrypt(Nonce::from_slice(&nonce_buffer), Payload { msg: &plaintext, aad: &[] })
			.unwrap();
		assert_eq!(&out[..plaintext.len()], &full[..plaintext.len()], "ciphertext differs");
		assert_eq!(
			&out[plaintext.len()..plaintext.len() + TRUNCATED_TAG_LEN],
			&full[plaintext.len()..plaintext.len() + TRUNCATED_TAG_LEN],
			"truncated tag differs"
		);
	}

	#[test]
	fn nonces_advance_and_the_generation_follows_the_top_byte() {
		let mut encryptor = encryptor();
		let mut out = Vec::new();
		assert_eq!(encryptor.generation(), 0);

		for _ in 0..3 {
			encryptor.encrypt_opus(&[0xfc; 8], &mut out).unwrap();
		}
		assert_eq!(encryptor.generation(), 0);

		// One past the 24-bit rollover is generation 1.
		encryptor.nonce = 1 << 24;
		assert_eq!(encryptor.generation(), 1);
		encryptor.encrypt_opus(&[0xfc; 8], &mut out).unwrap();
		// The frame's nonce is now two bytes of LEB128 or more.
		let supplemental = out[out.len() - 3] as usize;
		assert_eq!(supplemental, TRUNCATED_TAG_LEN + 1 + 2 + leb128_size(1 << 24));
	}

	#[test]
	fn a_new_epoch_resets_the_nonce() {
		let mut encryptor = encryptor();
		let mut out = Vec::new();
		encryptor.encrypt_opus(&[0xfc; 8], &mut out).unwrap();
		encryptor.set_base_secret(vec![1u8; 16]);
		assert_eq!(encryptor.generation(), 0);
		encryptor.encrypt_opus(&[0xfc; 8], &mut out).unwrap();
		// First frame of the new epoch is nonce 0 again, under a new key.
		assert_eq!(out[8 + TRUNCATED_TAG_LEN], 0);
	}

	#[test]
	fn exhausting_the_frame_nonce_is_an_error() {
		let mut encryptor = encryptor();
		encryptor.nonce = u32::MAX;
		let mut out = Vec::new();
		// Refused before the nonce is used, not after: reusing the last one
		// would be a repeated nonce under a live key.
		assert!(matches!(
			encryptor.encrypt_opus(&[0xfc; 8], &mut out),
			Err(FrameError::NonceExhausted)
		));
	}
}
