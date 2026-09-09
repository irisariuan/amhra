//! Voice gateway v8 wire types.
//!
//! Two framings share one socket. Text frames carry JSON `{ op, d, seq? }`;
//! binary frames carry the DAVE/MLS payloads as
//! `[u16 sequence][u8 opcode][payload]` inbound and `[u8 opcode][payload]`
//! outbound — the server numbers its own messages, the client does not.
//!
//! Every inbound frame of either kind advances the sequence number that
//! heartbeats and resumes must acknowledge, which is what lets a resumed
//! connection be told which messages it missed.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Gateway version. Below 4 was discontinued in November 2024; 8 is what the
/// DAVE opcodes and `seq_ack` require.
pub const GATEWAY_VERSION: u8 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Opcode {
	Identify = 0,
	SelectProtocol = 1,
	Ready = 2,
	Heartbeat = 3,
	SessionDescription = 4,
	Speaking = 5,
	HeartbeatAck = 6,
	Resume = 7,
	Hello = 8,
	Resumed = 9,
	ClientsConnect = 11,
	ClientDisconnect = 13,
	DavePrepareTransition = 21,
	DaveExecuteTransition = 22,
	DaveTransitionReady = 23,
	DavePrepareEpoch = 24,
	DaveMlsExternalSender = 25,
	DaveMlsKeyPackage = 26,
	DaveMlsProposals = 27,
	DaveMlsCommitWelcome = 28,
	DaveMlsAnnounceCommitTransition = 29,
	DaveMlsWelcome = 30,
	DaveMlsInvalidCommitWelcome = 31,
}

impl Opcode {
	pub const fn from_u8(value: u8) -> Option<Self> {
		Some(match value {
			0 => Self::Identify,
			1 => Self::SelectProtocol,
			2 => Self::Ready,
			3 => Self::Heartbeat,
			4 => Self::SessionDescription,
			5 => Self::Speaking,
			6 => Self::HeartbeatAck,
			7 => Self::Resume,
			8 => Self::Hello,
			9 => Self::Resumed,
			11 => Self::ClientsConnect,
			13 => Self::ClientDisconnect,
			21 => Self::DavePrepareTransition,
			22 => Self::DaveExecuteTransition,
			23 => Self::DaveTransitionReady,
			24 => Self::DavePrepareEpoch,
			25 => Self::DaveMlsExternalSender,
			26 => Self::DaveMlsKeyPackage,
			27 => Self::DaveMlsProposals,
			28 => Self::DaveMlsCommitWelcome,
			29 => Self::DaveMlsAnnounceCommitTransition,
			30 => Self::DaveMlsWelcome,
			31 => Self::DaveMlsInvalidCommitWelcome,
			_ => return None,
		})
	}

	/// DAVE payloads travel as binary frames; everything else is JSON.
	pub const fn is_binary(self) -> bool {
		(self as u8) >= 25
	}
}

/// Transport encryption modes still supported. AES-GCM is preferred where the
/// hardware has instructions for it; XChaCha20 is the one every server must
/// accept, so it is the fallback rather than the choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncryptionMode {
	AeadAes256GcmRtpSize,
	AeadXChaCha20Poly1305RtpSize,
}

impl EncryptionMode {
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::AeadAes256GcmRtpSize => "aead_aes256_gcm_rtpsize",
			Self::AeadXChaCha20Poly1305RtpSize => "aead_xchacha20_poly1305_rtpsize",
		}
	}

	pub fn parse(value: &str) -> Option<Self> {
		match value {
			"aead_aes256_gcm_rtpsize" => Some(Self::AeadAes256GcmRtpSize),
			"aead_xchacha20_poly1305_rtpsize" => Some(Self::AeadXChaCha20Poly1305RtpSize),
			_ => None,
		}
	}

	/// Nonce width the cipher expects. The 32-bit counter is written at the
	/// front of a zero-filled buffer of this size.
	pub const fn nonce_len(self) -> usize {
		match self {
			Self::AeadAes256GcmRtpSize => 12,
			Self::AeadXChaCha20Poly1305RtpSize => 24,
		}
	}

	/// Pick the best mode the server offered, in our order of preference.
	pub fn negotiate(offered: &[String]) -> Option<Self> {
		[Self::AeadAes256GcmRtpSize, Self::AeadXChaCha20Poly1305RtpSize]
			.into_iter()
			.find(|mode| offered.iter().any(|name| name == mode.as_str()))
	}
}

#[derive(Debug, Serialize)]
pub struct Identify<'a> {
	pub server_id: &'a str,
	pub user_id: &'a str,
	pub session_id: &'a str,
	pub token: &'a str,
	/// Highest DAVE protocol version this client can speak. Zero, or absent,
	/// declares no support.
	pub max_dave_protocol_version: u8,
}

#[derive(Debug, Serialize)]
pub struct SelectProtocol<'a> {
	pub protocol: &'a str,
	pub data: SelectProtocolData<'a>,
}

#[derive(Debug, Serialize)]
pub struct SelectProtocolData<'a> {
	pub address: &'a str,
	pub port: u16,
	pub mode: &'a str,
}

#[derive(Debug, Deserialize)]
pub struct Ready {
	pub ssrc: u32,
	pub ip: String,
	pub port: u16,
	pub modes: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct SessionDescription {
	pub mode: String,
	pub secret_key: Vec<u8>,
	#[serde(default)]
	pub dave_protocol_version: u8,
}

#[derive(Debug, Deserialize)]
pub struct Hello {
	pub heartbeat_interval: f64,
}

#[derive(Debug, Serialize)]
pub struct Resume<'a> {
	pub server_id: &'a str,
	pub session_id: &'a str,
	pub token: &'a str,
	pub seq_ack: u16,
}

#[derive(Debug, Serialize)]
pub struct Speaking {
	pub speaking: u8,
	pub ssrc: u32,
	pub delay: u8,
}

/// Bit 0 of the speaking flags: plain voice, as opposed to soundshare or
/// priority.
pub const SPEAKING_MICROPHONE: u8 = 1 << 0;

#[derive(Debug, Deserialize)]
pub struct DavePrepareTransition {
	pub protocol_version: u8,
	pub transition_id: u16,
}

#[derive(Debug, Deserialize)]
pub struct DaveExecuteTransition {
	pub transition_id: u16,
}

#[derive(Debug, Deserialize)]
pub struct DavePrepareEpoch {
	pub protocol_version: u8,
	pub epoch: u32,
}

/// An outbound JSON frame.
#[derive(Debug, Serialize)]
pub struct Outbound<T> {
	pub op: u8,
	pub d: T,
}

impl<T: Serialize> Outbound<T> {
	pub fn new(op: Opcode, d: T) -> Self {
		Self { op: op as u8, d }
	}
}

/// An inbound JSON frame, still un-interpreted.
#[derive(Debug, Deserialize)]
pub struct Inbound {
	pub op: u8,
	#[serde(default)]
	pub d: Value,
	/// Present on v8; the number a later resume has to acknowledge.
	#[serde(default)]
	pub seq: Option<u16>,
}

/// Split an inbound binary frame into its sequence, opcode and payload.
pub fn parse_binary(frame: &[u8]) -> Option<(u16, Opcode, &[u8])> {
	if frame.len() < 3 {
		return None;
	}
	let sequence = u16::from_be_bytes([frame[0], frame[1]]);
	let opcode = Opcode::from_u8(frame[2])?;
	Some((sequence, opcode, &frame[3..]))
}

/// Frame an outbound binary message. Outbound frames carry no sequence.
pub fn encode_binary(opcode: Opcode, payload: &[u8]) -> Vec<u8> {
	let mut frame = Vec::with_capacity(payload.len() + 1);
	frame.push(opcode as u8);
	frame.extend_from_slice(payload);
	frame
}

pub fn gateway_url(endpoint: &str) -> String {
	// The endpoint arrives as a bare host, sometimes with a port already on it.
	let host = endpoint.trim_start_matches("wss://").trim_end_matches('/');
	format!("wss://{host}/?v={GATEWAY_VERSION}")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn opcodes_round_trip() {
		for value in [0u8, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31] {
			let opcode = Opcode::from_u8(value).expect("known opcode");
			assert_eq!(opcode as u8, value);
		}
		// Gaps in the table must not decode to something plausible.
		assert!(Opcode::from_u8(10).is_none());
		assert!(Opcode::from_u8(12).is_none());
		assert!(Opcode::from_u8(32).is_none());
	}

	#[test]
	fn only_mls_opcodes_are_binary() {
		assert!(!Opcode::Identify.is_binary());
		assert!(!Opcode::DavePrepareTransition.is_binary());
		assert!(!Opcode::DavePrepareEpoch.is_binary());
		assert!(Opcode::DaveMlsExternalSender.is_binary());
		assert!(Opcode::DaveMlsKeyPackage.is_binary());
		assert!(Opcode::DaveMlsWelcome.is_binary());
	}

	#[test]
	fn binary_frames_split_correctly() {
		let frame = [0x00, 0x2a, 26, 0xde, 0xad, 0xbe, 0xef];
		let (sequence, opcode, payload) = parse_binary(&frame).unwrap();
		assert_eq!(sequence, 42);
		assert_eq!(opcode, Opcode::DaveMlsKeyPackage);
		assert_eq!(payload, &[0xde, 0xad, 0xbe, 0xef]);

		assert!(parse_binary(&[0x00, 0x01]).is_none());
		// Opcode 200 is not in the table, so the frame is not ours to act on.
		assert!(parse_binary(&[0x00, 0x01, 200]).is_none());
	}

	#[test]
	fn outbound_binary_carries_no_sequence() {
		let frame = encode_binary(Opcode::DaveMlsKeyPackage, &[1, 2, 3]);
		assert_eq!(frame, vec![26, 1, 2, 3]);
	}

	#[test]
	fn aes_is_preferred_when_offered() {
		let offered = vec![
			"aead_xchacha20_poly1305_rtpsize".to_owned(),
			"aead_aes256_gcm_rtpsize".to_owned(),
		];
		assert_eq!(EncryptionMode::negotiate(&offered), Some(EncryptionMode::AeadAes256GcmRtpSize));

		let only_chacha = vec!["aead_xchacha20_poly1305_rtpsize".to_owned()];
		assert_eq!(
			EncryptionMode::negotiate(&only_chacha),
			Some(EncryptionMode::AeadXChaCha20Poly1305RtpSize)
		);

		// The deprecated modes must never be selected, even if still offered.
		let dead = vec!["xsalsa20_poly1305".to_owned(), "xsalsa20_poly1305_lite".to_owned()];
		assert_eq!(EncryptionMode::negotiate(&dead), None);
	}

	#[test]
	fn nonce_widths_match_the_ciphers() {
		assert_eq!(EncryptionMode::AeadAes256GcmRtpSize.nonce_len(), 12);
		assert_eq!(EncryptionMode::AeadXChaCha20Poly1305RtpSize.nonce_len(), 24);
	}

	#[test]
	fn endpoints_become_versioned_urls() {
		assert_eq!(
			gateway_url("frankfurt1234.discord.media:443"),
			"wss://frankfurt1234.discord.media:443/?v=8"
		);
		// Already-prefixed endpoints must not end up with two schemes.
		assert_eq!(gateway_url("wss://x.discord.media/"), "wss://x.discord.media/?v=8");
	}
}
