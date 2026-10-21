//! DAVE frame encryption — the layer between the Opus encoder and the RTP
//! packet — and its inverse for frames other members send.
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

use super::ratchet::{HashRatchet, KEY_LEN, RatchetError};

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

	/// Jump the nonce, so a test can reach a later generation without
	/// encrypting 2²⁴ frames to get there.
	#[cfg(test)]
	pub(crate) fn set_nonce_for_test(&mut self, nonce: u32) {
		self.nonce = nonce;
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

/// An inbound frame's trailer, read backwards from the marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFrame {
	/// Bytes before the trailer: ciphertext, interleaved with any cleartext
	/// ranges.
	pub body_len: usize,
	pub tag: [u8; TRUNCATED_TAG_LEN],
	/// The 32-bit frame nonce. Its top byte is the ratchet generation.
	pub nonce: u32,
	/// Cleartext `(offset, len)` ranges within the body, in order and
	/// non-overlapping. Always empty for Opus; video packetizers need them.
	pub ranges: Vec<(usize, usize)>,
}

impl ParsedFrame {
	/// The ratchet generation this frame was sent under, before unwrapping.
	pub fn generation(&self) -> u32 {
		self.nonce >> GENERATION_SHIFT
	}
}

/// Read one LEB128 value of at most 32 bits.
///
/// Capped at five bytes: a longer run of continuation bits is not a nonce
/// anyone sent, and an uncapped shift is how a parser panics on noise.
fn read_leb128(bytes: &[u8]) -> Option<(u32, usize)> {
	let mut value = 0u64;
	for (index, byte) in bytes.iter().enumerate().take(5) {
		value |= u64::from(byte & 0x7f) << (7 * index);
		if byte & 0x80 == 0 {
			return u32::try_from(value).ok().map(|value| (value, index + 1));
		}
	}
	None
}

/// Parse a frame's trailer, or `None` if it is not a DAVE frame.
///
/// `None` covers both "never encrypted" and "malformed": a receiver treats the
/// two the same, passing the frame through only if passthrough is allowed.
pub fn parse_frame(frame: &[u8]) -> Option<ParsedFrame> {
	let len = frame.len();
	if len < SUPPLEMENTAL_BYTES || frame[len - MARKER.len()..] != MARKER {
		return None;
	}
	let supplemental = frame[len - MARKER.len() - 1] as usize;
	if supplemental < SUPPLEMENTAL_BYTES || supplemental > len {
		return None;
	}
	let start = len - supplemental;
	let tag: [u8; TRUNCATED_TAG_LEN] =
		frame[start..start + TRUNCATED_TAG_LEN].try_into().expect("checked length");

	// Between the tag and the size byte: the nonce, then the ranges.
	let mut rest = &frame[start + TRUNCATED_TAG_LEN..len - MARKER.len() - 1];
	let (nonce, used) = read_leb128(rest)?;
	rest = &rest[used..];

	let body_len = start;
	let mut ranges = Vec::new();
	let mut cursor = 0usize;
	while !rest.is_empty() {
		let (offset, used) = read_leb128(rest)?;
		rest = &rest[used..];
		let (size, used) = read_leb128(rest)?;
		rest = &rest[used..];
		let (offset, size) = (offset as usize, size as usize);
		// Ranges must be ordered, must not overlap, and must stay inside the
		// body. The trailer is not theirs to point at.
		let end = offset.checked_add(size)?;
		if offset < cursor || end > body_len {
			return None;
		}
		ranges.push((offset, size));
		cursor = end;
	}

	Some(ParsedFrame { body_len, tag, nonce, ranges })
}

/// Decrypt a parsed frame under one generation's key, writing the plaintext
/// frame — cleartext ranges back in place — into `out`.
///
/// Returns `false` if the tag does not verify, leaving `out` unspecified.
pub fn open_frame(
	key: &[u8; KEY_LEN],
	parsed: &ParsedFrame,
	frame: &[u8],
	out: &mut Vec<u8>,
) -> bool {
	let body = &frame[..parsed.body_len];
	let mut nonce = [0u8; 12];
	nonce[SYNC_NONCE_OFFSET..].copy_from_slice(&parsed.nonce.to_le_bytes());

	// Opus: the whole body is ciphertext and there is no AAD, so it decrypts
	// in place with no reassembly.
	if parsed.ranges.is_empty() {
		out.clear();
		out.extend_from_slice(body);
		return open_truncated(key, &nonce, &[], out, &parsed.tag);
	}

	let mut aad = Vec::new();
	let mut ciphertext = Vec::with_capacity(body.len());
	let mut cursor = 0;
	for &(offset, size) in &parsed.ranges {
		ciphertext.extend_from_slice(&body[cursor..offset]);
		aad.extend_from_slice(&body[offset..offset + size]);
		cursor = offset + size;
	}
	ciphertext.extend_from_slice(&body[cursor..]);
	if !open_truncated(key, &nonce, &aad, &mut ciphertext, &parsed.tag) {
		return false;
	}

	out.clear();
	out.reserve(body.len());
	let mut plaintext = ciphertext.as_slice();
	let mut cursor = 0;
	for &(offset, size) in &parsed.ranges {
		let (gap, remaining) = plaintext.split_at(offset - cursor);
		out.extend_from_slice(gap);
		out.extend_from_slice(&body[offset..offset + size]);
		plaintext = remaining;
		cursor = offset + size;
	}
	out.extend_from_slice(plaintext);
	true
}

/// AES-128-GCM decryption against a tag truncated to 8 bytes.
///
/// `aes-gcm` cannot do this: its tag sizes stop at 12. So GCM is assembled from
/// its two halves — GHASH for the tag, CTR for the keystream — exactly as
/// NIST SP 800-38D lays it out, and the tag is checked before a byte is
/// decrypted:
///
/// ```text
/// H  = AES(K, 0¹²⁸)
/// J0 = nonce ‖ 0³¹ ‖ 1
/// T  = AES(K, J0) ⊕ GHASH_H(A ‖ pad ‖ C ‖ pad ‖ len(A)₆₄ ‖ len(C)₆₄)
/// P  = C ⊕ CTR(K, J0 + 1)
/// ```
///
/// The comparison is constant-time, so a forger cannot learn the tag a byte
/// at a time from how long rejection takes.
fn open_truncated(
	key: &[u8; KEY_LEN],
	nonce: &[u8; 12],
	aad: &[u8],
	data: &mut [u8],
	tag: &[u8; TRUNCATED_TAG_LEN],
) -> bool {
	use aes::Aes128;
	// One `KeyInit` serves both: AES and GHASH share it through crypto-common.
	use aes::cipher::{BlockEncrypt, KeyInit as _, KeyIvInit, StreamCipher};
	use ghash::GHash;
	use ghash::universal_hash::UniversalHash;
	use subtle::ConstantTimeEq;

	let cipher = Aes128::new(key.into());
	let mut hash_key = aes::Block::default();
	cipher.encrypt_block(&mut hash_key);

	let mut ghash = GHash::new(&hash_key);
	ghash.update_padded(aad);
	ghash.update_padded(data);
	let mut lengths = aes::Block::default();
	lengths[..8].copy_from_slice(&(aad.len() as u64 * 8).to_be_bytes());
	lengths[8..].copy_from_slice(&(data.len() as u64 * 8).to_be_bytes());
	ghash.update(&[lengths]);
	let mut expected = ghash.finalize();

	let mut counter = aes::Block::default();
	counter[..12].copy_from_slice(nonce);
	counter[15] = 1;
	let mut mask = counter;
	cipher.encrypt_block(&mut mask);
	for (byte, mask) in expected.iter_mut().zip(mask.iter()) {
		*byte ^= mask;
	}
	if !bool::from(expected[..TRUNCATED_TAG_LEN].ct_eq(tag)) {
		return false;
	}

	counter[15] = 2;
	let mut keystream = ctr::Ctr32BE::<Aes128>::new(key.into(), &counter);
	keystream.apply_keystream(data);
	true
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

	fn key_for(generation: u32) -> [u8; KEY_LEN] {
		let mut ratchet = HashRatchet::new(vec![
			206, 221, 97, 177, 184, 161, 202, 105, 4, 101, 84, 40, 44, 247, 11, 123,
		]);
		ratchet.get(generation).unwrap().key
	}

	#[test]
	fn our_frames_parse_and_open_back_to_opus() {
		let mut encryptor = encryptor();
		let mut frame = Vec::new();
		let mut out = Vec::new();
		for (index, opus) in [&[0xfc, 1, 2, 3][..], &[0xfc; 120][..], &[0x78][..]].iter().enumerate() {
			encryptor.encrypt_opus(opus, &mut frame).unwrap();
			let parsed = parse_frame(&frame).expect("our own frame parses");
			assert_eq!(parsed.nonce, index as u32);
			assert_eq!(parsed.body_len, opus.len());
			assert!(parsed.ranges.is_empty());
			assert!(open_frame(&key_for(0), &parsed, &frame, &mut out));
			assert_eq!(&out, opus);
		}
	}

	#[test]
	fn a_late_generation_opens_with_its_own_key() {
		let mut encryptor = encryptor();
		encryptor.nonce = (3 << 24) | 77;
		let mut frame = Vec::new();
		encryptor.encrypt_opus(b"later", &mut frame).unwrap();
		let parsed = parse_frame(&frame).unwrap();
		assert_eq!(parsed.generation(), 3);
		let mut out = Vec::new();
		assert!(!open_frame(&key_for(0), &parsed, &frame, &mut out), "wrong generation's key");
		assert!(open_frame(&key_for(3), &parsed, &frame, &mut out));
		assert_eq!(out, b"later");
	}

	#[test]
	fn any_flipped_bit_fails_the_truncated_tag() {
		let mut frame = Vec::new();
		encryptor().encrypt_opus(&[0xfc, 9, 8, 7, 6, 5], &mut frame).unwrap();
		let body_len = parse_frame(&frame).unwrap().body_len;
		let mut out = Vec::new();
		// Every ciphertext byte and every tag byte is covered.
		for index in 0..body_len + TRUNCATED_TAG_LEN {
			let mut tampered = frame.clone();
			tampered[index] ^= 0x01;
			let parsed = parse_frame(&tampered).unwrap();
			assert!(!open_frame(&key_for(0), &parsed, &tampered, &mut out), "byte {index}");
		}
	}

	#[test]
	fn cleartext_ranges_are_authenticated_and_put_back() {
		// [clear 2][secret 5][clear 3], built with the full-tag cipher and then
		// truncated, the way a video sender lays out a frame.
		let key = key_for(0);
		let nonce_value = 5u32;
		let mut nonce = [0u8; 12];
		nonce[8..].copy_from_slice(&nonce_value.to_le_bytes());
		let (head, mut secret, tail) = ([0xaa, 0xbb], *b"hello", [0xcc, 0xdd, 0xee]);
		let aad = [&head[..], &tail[..]].concat();
		let tag = Aes128Gcm::new_from_slice(&key)
			.unwrap()
			.encrypt_in_place_detached(Nonce::from_slice(&nonce), &aad, &mut secret)
			.unwrap();

		let mut frame = [&head[..], &secret[..], &tail[..]].concat();
		frame.extend_from_slice(&tag[..TRUNCATED_TAG_LEN]);
		let trailer_start = frame.len();
		write_leb128(nonce_value, &mut frame);
		for value in [0, 2, 7, 3] {
			write_leb128(value, &mut frame);
		}
		let supplemental = TRUNCATED_TAG_LEN + (frame.len() - trailer_start) + 1 + MARKER.len();
		frame.push(supplemental as u8);
		frame.extend_from_slice(&MARKER);

		let parsed = parse_frame(&frame).unwrap();
		assert_eq!(parsed.ranges, vec![(0, 2), (7, 3)]);
		let mut out = Vec::new();
		assert!(open_frame(&key, &parsed, &frame, &mut out));
		assert_eq!(out, [&head[..], b"hello", &tail[..]].concat());

		// The cleartext is in the AAD: changing it breaks the tag.
		let mut tampered = frame.clone();
		tampered[0] ^= 1;
		assert!(!open_frame(&key, &parse_frame(&tampered).unwrap(), &tampered, &mut out));
	}

	#[test]
	fn malformed_trailers_are_not_frames() {
		let mut frame = Vec::new();
		encryptor().encrypt_opus(&[0xfc; 16], &mut frame).unwrap();
		let size_at = frame.len() - 3;

		// Plain Opus, and silence, carry no marker.
		assert!(parse_frame(&[0xfc; 40]).is_none());
		assert!(parse_frame(&crate::SILENCE_FRAME).is_none());

		// A size byte smaller than the fixed trailer, or larger than the frame.
		let mut bad = frame.clone();
		bad[size_at] = 5;
		assert!(parse_frame(&bad).is_none());
		bad[size_at] = 255;
		assert!(parse_frame(&bad).is_none());

		// A nonce whose continuation bits never end.
		let mut endless = vec![0xfc; 4];
		endless.extend_from_slice(&[0u8; TRUNCATED_TAG_LEN]);
		endless.extend_from_slice(&[0xff; 6]);
		endless.push((TRUNCATED_TAG_LEN + 6 + 3) as u8);
		endless.extend_from_slice(&MARKER);
		assert!(parse_frame(&endless).is_none());

		// A range that reaches into the trailer.
		let mut reaching = vec![0xfc; 4];
		reaching.extend_from_slice(&[0u8; TRUNCATED_TAG_LEN]);
		reaching.extend_from_slice(&[0, 2, 8]);
		reaching.push((TRUNCATED_TAG_LEN + 3 + 3) as u8);
		reaching.extend_from_slice(&MARKER);
		assert!(parse_frame(&reaching).is_none());
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
