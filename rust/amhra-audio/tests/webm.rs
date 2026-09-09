//! Demuxer tests over synthetic WebM, built here so the fixtures stay readable
//! and no binary blobs enter the repo.

use amhra_audio::webm::{DemuxError, Frame, WebmDemuxer};

/// Minimal-width size VINT.
fn size_vint(value: u64) -> Vec<u8> {
	for width in 1..=8u32 {
		let max = (1u64 << (7 * width)) - 1;
		// The all-ones pattern is reserved for "unknown size".
		if value < max {
			let marked = value | (1u64 << (7 * width));
			return marked.to_be_bytes()[8 - width as usize..].to_vec();
		}
	}
	panic!("size too large: {value}");
}

fn element(id: &[u8], payload: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(id.len() + 8 + payload.len());
	out.extend_from_slice(id);
	out.extend_from_slice(&size_vint(payload.len() as u64));
	out.extend_from_slice(payload);
	out
}

fn opus_head() -> Vec<u8> {
	let mut head = Vec::from(*b"OpusHead");
	head.push(1);
	head.push(2);
	head.extend_from_slice(&312u16.to_le_bytes());
	head.extend_from_slice(&48_000u32.to_le_bytes());
	head.extend_from_slice(&0i16.to_le_bytes());
	head.push(0);
	head
}

/// A distinguishable 20ms stereo CELT packet: TOC then a filler byte pattern.
fn opus_frame(marker: u8, len: usize) -> Vec<u8> {
	let mut frame = vec![0xfc];
	frame.resize(len, marker);
	frame
}

fn simple_block(track: u8, relative_ms: i16, flags: u8, frames: &[Vec<u8>]) -> Vec<u8> {
	let mut payload = vec![0x80 | track];
	payload.extend_from_slice(&relative_ms.to_be_bytes());
	payload.push(flags);
	for frame in frames {
		payload.extend_from_slice(frame);
	}
	element(&[0xa3], &payload)
}

struct Builder {
	clusters: Vec<u8>,
	duration_ms: Option<f64>,
}

impl Builder {
	fn new() -> Self {
		Self { clusters: Vec::new(), duration_ms: None }
	}

	fn duration(mut self, ms: f64) -> Self {
		self.duration_ms = Some(ms);
		self
	}

	fn cluster(mut self, timestamp_ms: u16, blocks: Vec<Vec<u8>>) -> Self {
		let mut payload = element(&[0xe7], &timestamp_ms.to_be_bytes());
		for block in blocks {
			payload.extend_from_slice(&block);
		}
		self.clusters.extend_from_slice(&element(&[0x1f, 0x43, 0xb6, 0x75], &payload));
		self
	}

	fn build(self) -> Vec<u8> {
		let mut info = element(&[0x2a, 0xd7, 0xb1], &1_000_000u32.to_be_bytes());
		if let Some(duration) = self.duration_ms {
			info.extend_from_slice(&element(&[0x44, 0x89], &duration.to_be_bytes()));
		}

		let mut entry = element(&[0xd7], &[1]);
		entry.extend_from_slice(&element(&[0x86], b"A_OPUS"));
		entry.extend_from_slice(&element(&[0x63, 0xa2], &opus_head()));

		let mut segment = element(&[0x15, 0x49, 0xa9, 0x66], &info);
		segment.extend_from_slice(&element(&[0x16, 0x54, 0xae, 0x6b], &element(&[0xae], &entry)));
		// An element the demuxer has no interest in: it must be skipped by size,
		// not parsed, and not mistaken for audio.
		segment.extend_from_slice(&element(&[0x1c, 0x53, 0xbb, 0x6b], &vec![0xa3; 512]));
		segment.extend_from_slice(&self.clusters);

		let mut file = element(&[0x1a, 0x45, 0xdf, 0xa3], &[0x42, 0x86, 0x81, 0x01]);
		file.extend_from_slice(&element(&[0x18, 0x53, 0x80, 0x67], &segment));
		file
	}
}

fn demux_all(file: &[u8], chunk_size: usize) -> (Vec<Frame>, WebmDemuxer) {
	let mut demuxer = WebmDemuxer::new();
	let mut frames = Vec::new();
	for chunk in file.chunks(chunk_size) {
		demuxer.feed(chunk, &mut |frame| frames.push(frame)).expect("valid webm");
	}
	(frames, demuxer)
}

fn two_cluster_file() -> Vec<u8> {
	let mut first = Vec::new();
	for i in 0..50u16 {
		first.push(simple_block(1, i as i16 * 20, 0x80, &[opus_frame(i as u8, 40)]));
	}
	let mut second = Vec::new();
	for i in 0..50u16 {
		second.push(simple_block(1, i as i16 * 20, 0x80, &[opus_frame(0x80 | i as u8, 60)]));
	}
	Builder::new().duration(2_000.0).cluster(0, first).cluster(1_000, second).build()
}

#[test]
fn reads_header_and_every_frame() {
	let file = two_cluster_file();
	let (frames, demuxer) = demux_all(&file, file.len());

	assert_eq!(frames.len(), 100);
	assert_eq!(demuxer.frame_count(), 100);
	let head = demuxer.head().expect("OpusHead parsed from CodecPrivate");
	assert_eq!(head.channels, 2);
	assert_eq!(head.pre_skip, 312);
	assert_eq!(demuxer.declared_duration_ms(), Some(2_000));
}

#[test]
fn frame_offsets_point_at_the_real_bytes() {
	let file = two_cluster_file();
	let (frames, _) = demux_all(&file, file.len());

	for (i, frame) in frames.iter().enumerate() {
		let start = frame.offset as usize;
		let bytes = &file[start..start + frame.len as usize];
		assert_eq!(bytes[0], 0xfc, "frame {i} does not start at a TOC byte");
		let expected_marker = if i < 50 { i as u8 } else { 0x80 | (i as u8 - 50) };
		assert_eq!(bytes[1], expected_marker, "frame {i} points at the wrong packet");
		assert_eq!(frame.len, if i < 50 { 40 } else { 60 });
	}
}

#[test]
fn timestamps_follow_cluster_and_block() {
	let file = two_cluster_file();
	let (frames, _) = demux_all(&file, file.len());

	assert_eq!(frames[0].timestamp_ms, 0);
	assert_eq!(frames[1].timestamp_ms, 20);
	assert_eq!(frames[49].timestamp_ms, 980);
	// Second cluster starts at 1000ms and its blocks are relative to it.
	assert_eq!(frames[50].timestamp_ms, 1_000);
	assert_eq!(frames[99].timestamp_ms, 1_980);
	assert!(frames.iter().all(|frame| frame.duration_us == 20_000));
}

#[test]
fn chunking_does_not_change_the_result() {
	let file = two_cluster_file();
	let (whole, _) = demux_all(&file, file.len());

	// One byte at a time is the worst case for a resumable parser: every
	// element header, block header and frame is split.
	for chunk_size in [1usize, 3, 7, 64, 997] {
		let (split, _) = demux_all(&file, chunk_size);
		assert_eq!(split, whole, "chunk size {chunk_size} produced different frames");
	}
}

#[test]
fn truncated_file_keeps_the_frames_it_had() {
	let file = two_cluster_file();
	// Cut mid-way through the second cluster, as a killed download would.
	let cut = file.len() * 3 / 4;
	let (frames, _) = demux_all(&file[..cut], 512);

	assert!(frames.len() > 50, "expected the first cluster to survive");
	assert!(frames.len() < 100, "expected the tail to be missing");
	assert!(frames.windows(2).all(|pair| pair[0].timestamp_ms <= pair[1].timestamp_ms));
}

#[test]
fn fixed_lacing_splits_into_equal_frames() {
	let frames_in = vec![opus_frame(1, 30), opus_frame(2, 30), opus_frame(3, 30)];
	// Fixed lacing: flags bit 0x04, then frame count minus one.
	let mut payload = vec![0x81, 0x00, 0x00, 0x04, 0x02];
	for frame in &frames_in {
		payload.extend_from_slice(frame);
	}
	let file = Builder::new().cluster(0, vec![element(&[0xa3], &payload)]).build();

	let (frames, _) = demux_all(&file, file.len());
	assert_eq!(frames.len(), 3);
	assert!(frames.iter().all(|frame| frame.len == 30));
	// Laced frames share a block timestamp, so each is placed by TOC duration.
	assert_eq!(frames[0].timestamp_ms, 0);
	assert_eq!(frames[1].timestamp_ms, 20);
	assert_eq!(frames[2].timestamp_ms, 40);
}

#[test]
fn other_tracks_are_ignored() {
	let file = Builder::new()
		.cluster(
			0,
			vec![
				simple_block(1, 0, 0x80, &[opus_frame(0xaa, 20)]),
				// A video track's block must not reach the Opus sink.
				simple_block(2, 0, 0x80, &[opus_frame(0xbb, 900)]),
				simple_block(1, 20, 0x80, &[opus_frame(0xcc, 20)]),
			],
		)
		.build();

	let (frames, _) = demux_all(&file, file.len());
	assert_eq!(frames.len(), 2);
	assert_eq!(frames[1].timestamp_ms, 20);
}

#[test]
fn non_webm_input_fails_loudly() {
	let mut demuxer = WebmDemuxer::new();
	let error = demuxer.feed(b"ID3\x04\x00\x00\x00\x00", &mut |_| {}).unwrap_err();
	assert!(matches!(error, DemuxError::NotWebm(_) | DemuxError::NoHeader));
}

#[test]
fn a_corrupt_size_field_is_an_error_not_an_allocation() {
	// A CodecPrivate claiming 2^40 bytes must be refused rather than buffered.
	let mut payload = vec![0x63, 0xa2];
	payload.extend_from_slice(&[0x09, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
	let mut file = element(&[0x1a, 0x45, 0xdf, 0xa3], &[0x42, 0x86, 0x81, 0x01]);
	file.extend_from_slice(&element(&[0x18, 0x53, 0x80, 0x67], &payload));

	let mut demuxer = WebmDemuxer::new();
	let error = demuxer.feed(&file, &mut |_| {}).unwrap_err();
	assert!(matches!(error, DemuxError::LeafTooLarge { .. }));
}
