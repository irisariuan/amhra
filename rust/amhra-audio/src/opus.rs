//! Opus packet inspection, limited to what the sender needs.
//!
//! Discord is fed Opus frames verbatim whenever gain is untouched, so the
//! pacer never decodes — but it still has to know how long each packet is in
//! order to advance the RTP timestamp by the right number of samples. That
//! number lives in the TOC byte (RFC 6716 §3.1), which is one byte to read
//! instead of a decoder to run.

/// Discord's voice pipeline is fixed at 48kHz.
pub const SAMPLE_RATE: u32 = 48_000;
/// Stereo, as Discord expects.
pub const CHANNELS: u8 = 2;
/// Samples per channel in a 20ms frame at 48kHz — the usual YouTube framing.
pub const FRAME_SIZE: u32 = 960;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PacketInfo {
	/// Total packet duration in microseconds, all frames counted.
	pub duration_us: u32,
	/// Frames packed into this one packet (1, 2, or 1..=48 for code 3).
	pub frames: u8,
	/// Whether the TOC declares stereo. A stream may switch mid-file; Opus
	/// allows it, and the decoder follows without being told.
	pub stereo: bool,
}

impl PacketInfo {
	/// Samples per channel at 48kHz. This is what the RTP timestamp advances by.
	#[inline]
	pub const fn samples(&self) -> u32 {
		// duration_us * 48_000 / 1_000_000, with the division folded to avoid
		// overflow on the 120ms maximum.
		self.duration_us * 48 / 1000
	}
}

/// Frame duration in microseconds for each of the 32 TOC configurations.
///
/// SILK modes (0..=11) cycle 10/20/40/60ms across their three bandwidths,
/// hybrid (12..=15) cycles 10/20, and CELT (16..=31) cycles 2.5/5/10/20.
const FRAME_US: [u32; 32] = [
	// SILK NB, MB, WB
	10_000, 20_000, 40_000, 60_000, //
	10_000, 20_000, 40_000, 60_000, //
	10_000, 20_000, 40_000, 60_000, //
	// Hybrid SWB, FB
	10_000, 20_000, //
	10_000, 20_000, //
	// CELT NB, WB, SWB, FB
	2_500, 5_000, 10_000, 20_000, //
	2_500, 5_000, 10_000, 20_000, //
	2_500, 5_000, 10_000, 20_000, //
	2_500, 5_000, 10_000, 20_000, //
];

/// Read the TOC of an Opus packet.
///
/// Returns `None` for an empty packet or a code-3 packet whose frame count is
/// zero — both are malformed, and a caller that trusted the duration would
/// silently desynchronise the RTP clock rather than skip a bad frame.
#[inline]
pub fn packet_info(packet: &[u8]) -> Option<PacketInfo> {
	let toc = *packet.first()?;
	let config = (toc >> 3) as usize;
	let stereo = (toc & 0x04) != 0;
	let per_frame = FRAME_US[config];

	let frames = match toc & 0x03 {
		0 => 1,
		1 | 2 => 2,
		// Code 3 keeps the count in the low six bits of the next byte.
		_ => {
			let count = *packet.get(1)? & 0x3f;
			if count == 0 {
				return None;
			}
			count
		}
	};

	// RFC 6716 caps a packet at 120ms; anything longer is a corrupt TOC.
	let duration_us = per_frame.checked_mul(frames as u32)?;
	if duration_us > 120_000 {
		return None;
	}

	Some(PacketInfo { duration_us, frames, stereo })
}

/// The `OpusHead` identification header, carried in Matroska's CodecPrivate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpusHead {
	pub channels: u8,
	/// Samples to discard at the start of the stream, at 48kHz.
	pub pre_skip: u16,
	/// Sample rate of the source before encoding. Informational: the packets
	/// themselves are always decoded at 48kHz.
	pub input_sample_rate: u32,
	/// Q7.8 fixed-point gain the decoder is expected to apply. Never used on
	/// the Discord path, since the container header is not transmitted.
	pub output_gain: i16,
}

impl OpusHead {
	pub fn parse(data: &[u8]) -> Option<Self> {
		// magic(8) version(1) channels(1) pre_skip(2) rate(4) gain(2) family(1)
		if data.len() < 19 || &data[..8] != b"OpusHead" {
			return None;
		}
		Some(Self {
			channels: data[9],
			pre_skip: u16::from_le_bytes([data[10], data[11]]),
			input_sample_rate: u32::from_le_bytes([data[12], data[13], data[14], data[15]]),
			output_gain: i16::from_le_bytes([data[16], data[17]]),
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// itag 251 as YouTube ships it: CELT fullband, 20ms, stereo, one frame.
	#[test]
	fn youtube_stereo_20ms() {
		let info = packet_info(&[0xfc, 0x00, 0x00]).unwrap();
		assert_eq!(info.duration_us, 20_000);
		assert_eq!(info.frames, 1);
		assert!(info.stereo);
		assert_eq!(info.samples(), FRAME_SIZE);
	}

	#[test]
	fn silk_narrowband_60ms_mono() {
		// config 3 -> 60ms, mono, code 0
		let info = packet_info(&[0x18, 0x00]).unwrap();
		assert_eq!(info.duration_us, 60_000);
		assert!(!info.stereo);
		assert_eq!(info.samples(), 2880);
	}

	#[test]
	fn code_two_packs_two_frames() {
		// config 16 (CELT NB 2.5ms), code 1 -> two frames
		let info = packet_info(&[0x81, 0x00]).unwrap();
		assert_eq!(info.frames, 2);
		assert_eq!(info.duration_us, 5_000);
	}

	#[test]
	fn code_three_reads_its_count() {
		// config 31 (CELT FB 20ms), code 3, 3 frames -> 60ms
		let info = packet_info(&[0xff, 0x03, 0x00]).unwrap();
		assert_eq!(info.frames, 3);
		assert_eq!(info.duration_us, 60_000);
	}

	#[test]
	fn malformed_packets_are_rejected() {
		assert!(packet_info(&[]).is_none());
		// code 3 with no frame-count byte
		assert!(packet_info(&[0xff]).is_none());
		// code 3 declaring zero frames
		assert!(packet_info(&[0xff, 0x00]).is_none());
		// 48 frames of 20ms is 960ms, far past the 120ms ceiling
		assert!(packet_info(&[0xff, 0x30]).is_none());
	}

	#[test]
	fn opus_head_round_trip() {
		let mut head = Vec::from(*b"OpusHead");
		head.push(1); // version
		head.push(2); // channels
		head.extend_from_slice(&312u16.to_le_bytes());
		head.extend_from_slice(&48_000u32.to_le_bytes());
		head.extend_from_slice(&0i16.to_le_bytes());
		head.push(0); // mapping family
		let parsed = OpusHead::parse(&head).unwrap();
		assert_eq!(parsed.channels, 2);
		assert_eq!(parsed.pre_skip, 312);
		assert_eq!(parsed.input_sample_rate, 48_000);
	}

	#[test]
	fn non_opus_codec_private_is_rejected() {
		assert!(OpusHead::parse(b"OpusTags............").is_none());
		assert!(OpusHead::parse(b"OpusHead").is_none());
	}
}
