//! DAVE: Discord's end-to-end encryption for audio and video.
//!
//! The server requires it — a client identifying with
//! `max_dave_protocol_version: 0` is closed with 4017 before the session opens,
//! measured 2026-08-13.
//!
//! Three layers sit under that requirement. MLS (RFC 9420) agrees a group
//! secret, which is `openmls`' job. From that secret each sender exports a base
//! secret and ratchets it forward ([`ratchet`]). Each media frame is then
//! encrypted under the current generation's key and given a trailer the
//! receiver can parse backwards ([`frame`]). The derivations MLS specifies but
//! `openmls` will not perform at DAVE's odd lengths live in [`kdf`].

pub mod driver;
pub mod frame;
pub mod kdf;
pub mod ratchet;
pub mod session;

/// The DAVE protocol version this build speaks.
pub const PROTOCOL_VERSION: u8 = 1;

/// MLS exporter label for a sender's base secret.
pub const MEDIA_KEY_BASE_LABEL: &str = "Discord Secure Frames v0";
/// Exported secret length.
pub const MEDIA_KEY_BASE_LEN: usize = 16;

/// The exporter context for a user: their id as a little-endian u64.
pub fn exporter_context(user_id: u64) -> [u8; 8] {
	user_id.to_le_bytes()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn exporter_context_is_little_endian() {
		assert_eq!(exporter_context(1), [1, 0, 0, 0, 0, 0, 0, 0]);
		assert_eq!(
			exporter_context(956_459_806_691_065_856),
			956_459_806_691_065_856u64.to_le_bytes()
		);
	}
}
