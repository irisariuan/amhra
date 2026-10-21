//! Fixtures the player and mixer tests share: a WebM writer small enough to
//! read, and real Opus packets to put in it.

use std::path::PathBuf;

use amhra_audio::CacheReader;
use amhra_audio::opus::{CHANNELS, FRAME_SIZE, SAMPLE_RATE};

fn size_vint(value: u64) -> Vec<u8> {
	for width in 1..=8u32 {
		let max = (1u64 << (7 * width)) - 1;
		if value < max {
			let marked = value | (1u64 << (7 * width));
			return marked.to_be_bytes()[8 - width as usize..].to_vec();
		}
	}
	unreachable!()
}

fn element(id: &[u8], payload: &[u8]) -> Vec<u8> {
	let mut out = Vec::new();
	out.extend_from_slice(id);
	out.extend_from_slice(&size_vint(payload.len() as u64));
	out.extend_from_slice(payload);
	out
}

/// A WebM/Opus file holding `packets` as consecutive 20ms frames.
pub fn webm(packets: &[Vec<u8>]) -> Vec<u8> {
	let mut head = Vec::from(*b"OpusHead");
	head.extend_from_slice(&[1, 2]);
	head.extend_from_slice(&312u16.to_le_bytes());
	head.extend_from_slice(&48_000u32.to_le_bytes());
	head.extend_from_slice(&0i16.to_le_bytes());
	head.push(0);

	let mut entry = element(&[0xd7], &[1]);
	entry.extend_from_slice(&element(&[0x86], b"A_OPUS"));
	entry.extend_from_slice(&element(&[0x63, 0xa2], &head));

	let mut segment = element(&[0x15, 0x49, 0xa9, 0x66], &element(
		&[0x2a, 0xd7, 0xb1],
		&1_000_000u32.to_be_bytes(),
	));
	segment.extend_from_slice(&element(&[0x16, 0x54, 0xae, 0x6b], &element(&[0xae], &entry)));

	let mut payload = element(&[0xe7], &0u16.to_be_bytes());
	for (frame, packet) in packets.iter().enumerate() {
		let mut block = vec![0x81];
		block.extend_from_slice(&((frame * 20) as i16).to_be_bytes());
		block.push(0x80);
		block.extend_from_slice(packet);
		payload.extend_from_slice(&element(&[0xa3], &block));
	}
	segment.extend_from_slice(&element(&[0x1f, 0x43, 0xb6, 0x75], &payload));

	let mut file = element(&[0x1a, 0x45, 0xdf, 0xa3], &[0x42, 0x86, 0x81, 0x01]);
	file.extend_from_slice(&element(&[0x18, 0x53, 0x80, 0x67], &segment));
	file
}

/// A packet that is not real audio but is recognisably from one source: a
/// 20ms stereo TOC byte followed by `marker`.
pub fn marker_packet(marker: u8) -> Vec<u8> {
	let mut packet = vec![0xfc];
	packet.extend_from_slice(&[marker; 19]);
	packet
}

/// A real Opus packet: 20ms of a 440Hz tone at `amplitude`.
pub fn tone_packet(amplitude: i16) -> Vec<u8> {
	let mut encoder =
		opus::Encoder::new(SAMPLE_RATE, opus::Channels::Stereo, opus::Application::Audio).unwrap();
	let mut pcm = vec![0i16; FRAME_SIZE as usize * CHANNELS as usize];
	for (index, sample) in pcm.iter_mut().enumerate() {
		let phase = (index / CHANNELS as usize) as f32 / SAMPLE_RATE as f32;
		*sample = ((phase * 440.0 * std::f32::consts::TAU).sin() * amplitude as f32) as i16;
	}
	let mut out = vec![0u8; 4000];
	let written = encoder.encode(&pcm, &mut out).unwrap();
	out.truncate(written);
	out
}

pub fn temp_path(name: &str) -> PathBuf {
	let mut path = std::env::temp_dir();
	path.push(format!("amhra-voice-{name}-{}.music", std::process::id()));
	path
}

/// A reader over a finished file of `packets`.
pub fn reader(name: &str, packets: &[Vec<u8>]) -> (CacheReader, PathBuf) {
	let path = temp_path(name);
	std::fs::write(&path, webm(packets)).unwrap();
	let mut reader = CacheReader::open_path(&path, None).unwrap();
	reader.mark_complete();
	(reader, path)
}
