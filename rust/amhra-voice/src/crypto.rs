//! RTP framing and transport encryption.
//!
//! One packet looks like this:
//!
//! ```text
//! [ RTP header, 12 bytes, plaintext ][ AEAD ciphertext ‖ tag ][ nonce, 4 bytes ]
//!   0x80 0x78 seq:u16 ts:u32 ssrc:u32
//! ```
//!
//! The RTP header is the additional authenticated data, so it is covered by the
//! tag without being hidden — routers need to read it. The nonce is a 32-bit
//! counter written at the front of an otherwise zero-filled buffer of the
//! cipher's nonce width, and repeated in the clear at the end of the packet so
//! the receiver can reconstruct it. It must never repeat under one key: with
//! AES-GCM a repeat is not a decryption failure but a key compromise, which is
//! why the counter wrapping is treated as a fatal condition rather than a
//! wrap-around.

use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Key as AesKey};
use chacha20poly1305::XChaCha20Poly1305;

use crate::wire::EncryptionMode;

/// RTP version 2, no padding, no extension, no CSRCs.
const RTP_VERSION_FLAGS: u8 = 0x80;
/// Discord's payload type for Opus.
const RTP_OPUS_PAYLOAD_TYPE: u8 = 0x78;
pub const RTP_HEADER_LEN: usize = 12;
/// The 16-byte tag every AEAD here produces.
pub const TAG_LEN: usize = 16;
/// Bytes of counter appended after the ciphertext.
pub const NONCE_SUFFIX_LEN: usize = 4;

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
	#[error("secret key must be 32 bytes, got {0}")]
	BadKeyLength(usize),
	#[error("encryption failed")]
	Encrypt,
	#[error("nonce counter exhausted; the session must be rekeyed")]
	NonceExhausted,
}

/// Everything needed to turn an Opus packet into a wire packet.
pub struct Session {
	cipher: Cipher,
	mode: EncryptionMode,
	ssrc: u32,
	sequence: u16,
	timestamp: u32,
	nonce: u32,
	/// Reused across packets so the hot path allocates nothing.
	nonce_buffer: [u8; 24],
}

enum Cipher {
	Aes(Box<Aes256Gcm>),
	XChaCha(Box<XChaCha20Poly1305>),
}

impl std::fmt::Debug for Session {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		// The key must not reach a log line.
		f.debug_struct("Session")
			.field("mode", &self.mode.as_str())
			.field("ssrc", &self.ssrc)
			.field("sequence", &self.sequence)
			.field("timestamp", &self.timestamp)
			.finish_non_exhaustive()
	}
}

impl Session {
	/// Start a session. Sequence and timestamp start at random values, as RTP
	/// requires — a predictable start leaks how long the stream has run and
	/// makes packets easier to forge.
	pub fn new(mode: EncryptionMode, secret_key: &[u8], ssrc: u32) -> Result<Self, CryptoError> {
		Self::with_start(mode, secret_key, ssrc, rand::random(), rand::random())
	}

	/// Deterministic constructor, for tests.
	pub fn with_start(
		mode: EncryptionMode,
		secret_key: &[u8],
		ssrc: u32,
		sequence: u16,
		timestamp: u32,
	) -> Result<Self, CryptoError> {
		if secret_key.len() != 32 {
			return Err(CryptoError::BadKeyLength(secret_key.len()));
		}
		let cipher = match mode {
			EncryptionMode::AeadAes256GcmRtpSize => {
				Cipher::Aes(Box::new(Aes256Gcm::new(AesKey::<Aes256Gcm>::from_slice(secret_key))))
			}
			EncryptionMode::AeadXChaCha20Poly1305RtpSize => Cipher::XChaCha(Box::new(
				XChaCha20Poly1305::new(secret_key.into()),
			)),
		};
		Ok(Self {
			cipher,
			mode,
			ssrc,
			sequence,
			timestamp,
			nonce: 0,
			nonce_buffer: [0u8; 24],
		})
	}

	pub fn ssrc(&self) -> u32 {
		self.ssrc
	}

	pub fn sequence(&self) -> u16 {
		self.sequence
	}

	pub fn timestamp(&self) -> u32 {
		self.timestamp
	}

	/// Advance the RTP clock by one frame's worth of samples.
	///
	/// Taken from the packet's own duration rather than assumed to be 960: a
	/// source that is not 20ms would otherwise drift against the listener's
	/// clock, slowly, in a way that sounds like the track speeding up.
	pub fn advance(&mut self, samples: u32) {
		self.sequence = self.sequence.wrapping_add(1);
		self.timestamp = self.timestamp.wrapping_add(samples);
	}

	/// Build one wire packet into `out`, which is cleared first.
	///
	/// `payload` is the Opus packet, already DAVE-encrypted if the session is
	/// end-to-end encrypted.
	pub fn seal(&mut self, payload: &[u8], out: &mut Vec<u8>) -> Result<(), CryptoError> {
		// Wrapping the counter would reuse a nonce under the same key. Discord
		// rekeys long before this, so reaching it means something is wrong.
		let nonce = self.nonce.checked_add(1).ok_or(CryptoError::NonceExhausted)?;
		self.nonce = nonce;

		out.clear();
		out.reserve(RTP_HEADER_LEN + payload.len() + TAG_LEN + NONCE_SUFFIX_LEN);
		out.push(RTP_VERSION_FLAGS);
		out.push(RTP_OPUS_PAYLOAD_TYPE);
		out.extend_from_slice(&self.sequence.to_be_bytes());
		out.extend_from_slice(&self.timestamp.to_be_bytes());
		out.extend_from_slice(&self.ssrc.to_be_bytes());

		let (header, body) = out.split_at(RTP_HEADER_LEN);
		debug_assert!(body.is_empty());
		let mut aad = [0u8; RTP_HEADER_LEN];
		aad.copy_from_slice(header);

		self.nonce_buffer = [0u8; 24];
		self.nonce_buffer[..4].copy_from_slice(&nonce.to_be_bytes());
		let nonce_bytes = &self.nonce_buffer[..self.mode.nonce_len()];

		// Encrypt in place at the end of the packet: the ciphertext is the same
		// length as the plaintext, and the tag is appended by the AEAD.
		let start = out.len();
		out.extend_from_slice(payload);
		let mut buffer = InPlace { data: out, start };
		match &self.cipher {
			Cipher::Aes(cipher) => cipher
				.encrypt_in_place(nonce_bytes.into(), &aad, &mut buffer)
				.map_err(|_| CryptoError::Encrypt)?,
			Cipher::XChaCha(cipher) => cipher
				.encrypt_in_place(nonce_bytes.into(), &aad, &mut buffer)
				.map_err(|_| CryptoError::Encrypt)?,
		}

		out.extend_from_slice(&nonce.to_be_bytes());
		Ok(())
	}
}

/// Adapts the tail of the output packet to the in-place AEAD interface, so the
/// ciphertext is written where it belongs instead of into a scratch allocation.
struct InPlace<'a> {
	data: &'a mut Vec<u8>,
	start: usize,
}

impl aes_gcm::aead::Buffer for InPlace<'_> {
	fn extend_from_slice(&mut self, other: &[u8]) -> aes_gcm::aead::Result<()> {
		self.data.extend_from_slice(other);
		Ok(())
	}

	fn truncate(&mut self, len: usize) {
		self.data.truncate(self.start + len);
	}
}

impl AsRef<[u8]> for InPlace<'_> {
	fn as_ref(&self) -> &[u8] {
		&self.data[self.start..]
	}
}

impl AsMut<[u8]> for InPlace<'_> {
	fn as_mut(&mut self) -> &mut [u8] {
		&mut self.data[self.start..]
	}
}

/// Silence, as Discord expects it: three of these end a speaking burst so the
/// listener's decoder does not interpolate across the gap.
pub const SILENCE_FRAME: [u8; 3] = [0xf8, 0xff, 0xfe];

#[cfg(test)]
mod tests {
	use super::*;
	use aes_gcm::aead::Aead;
	use aes_gcm::aead::Payload;

	const KEY: [u8; 32] = [7u8; 32];

	fn session(mode: EncryptionMode) -> Session {
		Session::with_start(mode, &KEY, 0xdead_beef, 1000, 5000).unwrap()
	}

	#[test]
	fn header_layout_matches_the_protocol() {
		let mut session = session(EncryptionMode::AeadAes256GcmRtpSize);
		let mut packet = Vec::new();
		session.seal(&[0xfc, 0x01, 0x02], &mut packet).unwrap();

		assert_eq!(packet[0], 0x80);
		assert_eq!(packet[1], 0x78);
		assert_eq!(u16::from_be_bytes([packet[2], packet[3]]), 1000);
		assert_eq!(u32::from_be_bytes([packet[4], packet[5], packet[6], packet[7]]), 5000);
		assert_eq!(u32::from_be_bytes([packet[8], packet[9], packet[10], packet[11]]), 0xdead_beef);
	}

	#[test]
	fn packet_length_accounts_for_tag_and_nonce() {
		for mode in
			[EncryptionMode::AeadAes256GcmRtpSize, EncryptionMode::AeadXChaCha20Poly1305RtpSize]
		{
			let mut session = session(mode);
			let payload = vec![0xfc; 160];
			let mut packet = Vec::new();
			session.seal(&payload, &mut packet).unwrap();
			assert_eq!(
				packet.len(),
				RTP_HEADER_LEN + payload.len() + TAG_LEN + NONCE_SUFFIX_LEN,
				"wrong length for {}",
				mode.as_str()
			);
		}
	}

	#[test]
	fn ciphertext_decrypts_with_the_documented_nonce_and_aad() {
		let mut session = session(EncryptionMode::AeadAes256GcmRtpSize);
		let payload = b"an opus packet, notionally".to_vec();
		let mut packet = Vec::new();
		session.seal(&payload, &mut packet).unwrap();

		let header = &packet[..RTP_HEADER_LEN];
		let counter = &packet[packet.len() - NONCE_SUFFIX_LEN..];
		let ciphertext = &packet[RTP_HEADER_LEN..packet.len() - NONCE_SUFFIX_LEN];

		// Rebuild the nonce the way a receiver would: the trailing counter, then
		// zeros out to the cipher's width.
		let mut nonce = [0u8; 12];
		nonce[..4].copy_from_slice(counter);

		let cipher = Aes256Gcm::new(AesKey::<Aes256Gcm>::from_slice(&KEY));
		let decrypted = cipher
			.decrypt(&nonce.into(), Payload { msg: ciphertext, aad: header })
			.expect("receiver can decrypt");
		assert_eq!(decrypted, payload);
	}

	#[test]
	fn xchacha_decrypts_the_same_way() {
		use chacha20poly1305::aead::Aead as _;
		use chacha20poly1305::KeyInit as _;

		let mut session = session(EncryptionMode::AeadXChaCha20Poly1305RtpSize);
		let payload = b"another packet".to_vec();
		let mut packet = Vec::new();
		session.seal(&payload, &mut packet).unwrap();

		let header = &packet[..RTP_HEADER_LEN];
		let counter = &packet[packet.len() - NONCE_SUFFIX_LEN..];
		let ciphertext = &packet[RTP_HEADER_LEN..packet.len() - NONCE_SUFFIX_LEN];
		let mut nonce = [0u8; 24];
		nonce[..4].copy_from_slice(counter);

		let cipher = XChaCha20Poly1305::new((&KEY).into());
		let decrypted = cipher
			.decrypt(&nonce.into(), chacha20poly1305::aead::Payload { msg: ciphertext, aad: header })
			.expect("receiver can decrypt");
		assert_eq!(decrypted, payload);
	}

	#[test]
	fn the_nonce_counter_never_repeats() {
		let mut session = session(EncryptionMode::AeadAes256GcmRtpSize);
		let mut seen = Vec::new();
		for _ in 0..64 {
			let mut packet = Vec::new();
			session.seal(b"x", &mut packet).unwrap();
			seen.push(packet[packet.len() - 4..].to_vec());
		}
		let unique: std::collections::HashSet<_> = seen.iter().collect();
		assert_eq!(unique.len(), seen.len(), "a nonce was reused");
	}

	#[test]
	fn exhausting_the_counter_is_an_error_not_a_wrap() {
		let mut session = session(EncryptionMode::AeadAes256GcmRtpSize);
		session.nonce = u32::MAX;
		let mut packet = Vec::new();
		assert!(matches!(session.seal(b"x", &mut packet), Err(CryptoError::NonceExhausted)));
	}

	#[test]
	fn advance_moves_the_rtp_clock_by_real_samples() {
		let mut session = session(EncryptionMode::AeadAes256GcmRtpSize);
		session.advance(960);
		assert_eq!(session.sequence(), 1001);
		assert_eq!(session.timestamp(), 5960);
		// A 60ms SILK frame is 2880 samples, not 960.
		session.advance(2880);
		assert_eq!(session.timestamp(), 8840);
	}

	#[test]
	fn short_keys_are_refused() {
		assert!(matches!(
			Session::new(EncryptionMode::AeadAes256GcmRtpSize, &[0u8; 16], 1),
			Err(CryptoError::BadKeyLength(16))
		));
	}
}
