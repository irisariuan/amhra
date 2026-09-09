//! Tests for the paths taken when the native extractor cannot serve a track.
//!
//! None of these reach YouTube. What is under test is the plumbing around the
//! fallback — where files land, what counts as already cached — which is what
//! broke in practice while the extractor itself was fine.

use std::path::PathBuf;

use amhra_fetch::download::CachePaths;

fn scratch(name: &str) -> PathBuf {
	let mut path = std::env::temp_dir();
	path.push(format!("amhra-fallback-{name}-{}", std::process::id()));
	path
}

/// A minimal WebM/Opus file, so a cache entry can be indexable.
fn webm() -> Vec<u8> {
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

	let mut head = Vec::from(*b"OpusHead");
	head.extend_from_slice(&[1, 2]);
	head.extend_from_slice(&312u16.to_le_bytes());
	head.extend_from_slice(&48_000u32.to_le_bytes());
	head.extend_from_slice(&0i16.to_le_bytes());
	head.push(0);

	let mut entry = element(&[0xd7], &[1]);
	entry.extend_from_slice(&element(&[0x86], b"A_OPUS"));
	entry.extend_from_slice(&element(&[0x63, 0xa2], &head));

	let mut segment = element(
		&[0x15, 0x49, 0xa9, 0x66],
		&element(&[0x2a, 0xd7, 0xb1], &1_000_000u32.to_be_bytes()),
	);
	segment.extend_from_slice(&element(&[0x16, 0x54, 0xae, 0x6b], &element(&[0xae], &entry)));

	let mut payload = element(&[0xe7], &0u16.to_be_bytes());
	for frame in 0..50u16 {
		let mut block = vec![0x81];
		block.extend_from_slice(&((frame * 20) as i16).to_be_bytes());
		block.push(0x80);
		block.push(0xfc);
		block.extend_from_slice(&[0x42; 39]);
		payload.extend_from_slice(&element(&[0xa3], &block));
	}
	segment.extend_from_slice(&element(&[0x1f, 0x43, 0xb6, 0x75], &payload));

	let mut file = element(&[0x1a, 0x45, 0xdf, 0xa3], &[0x42, 0x86, 0x81, 0x01]);
	file.extend_from_slice(&element(&[0x18, 0x53, 0x80, 0x67], &segment));
	file
}

/// An ID3-tagged AAC file, which is what yt-dlp falls back to for a video with
/// no Opus format — and what this build cannot demux.
fn aac() -> Vec<u8> {
	let mut file = Vec::from(*b"ID3\x03\x00\x00\x00\x00\x00\x3f");
	file.extend_from_slice(&[0xff, 0xf1, 0x50, 0x80]);
	file.resize(4096, 0);
	file
}

#[tokio::test]
async fn a_webm_entry_is_a_hit_and_gains_an_index() {
	let dir = scratch("indexable");
	tokio::fs::create_dir_all(&dir).await.unwrap();
	let paths = CachePaths::new(&dir, "abcdefghijk");
	tokio::fs::write(&paths.music, webm()).await.unwrap();

	let options = amhra_fetch::FetchOptions {
		cache_dir: dir.clone(),
		profiles: None,
		download: Default::default(),
		allow_fallback: false,
		force: false,
	};
	let result = amhra_fetch::fetch("abcdefghijk", &options, |_, _| {}).await.expect("cache hit");

	assert_eq!(result.source, amhra_fetch::Source::Cache);
	assert!(result.index_path.is_some(), "an indexable entry should be indexed on first use");
	assert!(paths.index.exists());

	tokio::fs::remove_dir_all(&dir).await.ok();
}

/// The regression this test exists for: an entry that cannot be indexed was
/// reported as a miss, so every play re-downloaded it, produced the same
/// un-indexable file, and missed again.
#[tokio::test]
async fn an_unindexable_entry_is_still_a_hit() {
	let dir = scratch("aac");
	tokio::fs::create_dir_all(&dir).await.unwrap();
	let paths = CachePaths::new(&dir, "aacOnlyVid1");
	tokio::fs::write(&paths.music, aac()).await.unwrap();

	let options = amhra_fetch::FetchOptions {
		cache_dir: dir.clone(),
		profiles: None,
		download: Default::default(),
		// No network and no fallback: if this is treated as a miss, the fetch
		// fails outright, which is exactly what it used to do on every play.
		allow_fallback: false,
		force: false,
	};
	let result = amhra_fetch::fetch("aacOnlyVid1", &options, |_, _| {})
		.await
		.expect("a cached file is a hit even when it cannot be indexed");

	assert_eq!(result.source, amhra_fetch::Source::Cache);
	assert!(result.index_path.is_none(), "there is no index to point at");
	assert!(!paths.index.exists(), "no index should be left behind");
	assert_eq!(result.bytes, 4096);

	tokio::fs::remove_dir_all(&dir).await.ok();
}

#[tokio::test]
async fn an_empty_cache_file_is_not_a_hit() {
	let dir = scratch("empty");
	tokio::fs::create_dir_all(&dir).await.unwrap();
	let paths = CachePaths::new(&dir, "emptyFile01");
	tokio::fs::write(&paths.music, b"").await.unwrap();

	let options = amhra_fetch::FetchOptions {
		cache_dir: dir.clone(),
		profiles: None,
		download: Default::default(),
		allow_fallback: false,
		force: false,
	};
	// A zero-byte file is a download that died, not a track.
	assert!(amhra_fetch::fetch("emptyFile01", &options, |_, _| {}).await.is_err());

	tokio::fs::remove_dir_all(&dir).await.ok();
}

#[tokio::test]
async fn the_fallback_creates_the_cache_directory() {
	// The native path creates it, so the fallback inheriting a missing one is
	// how "the fallback does not work" looked from outside.
	let dir = scratch("missing").join("nested").join("cache");
	assert!(!dir.exists());

	let paths = CachePaths::new(&dir, "whateverId1");
	// Any yt-dlp invocation fails here (the id is not a video), but it must
	// fail on yt-dlp's terms rather than on a missing directory.
	let error = amhra_fetch::ytdlp::download("https://example.invalid/x", &paths)
		.await
		.expect_err("this cannot succeed");

	assert!(
		!matches!(error, amhra_fetch::ytdlp::FallbackError::Cache { .. }),
		"the directory should have been created, got {error}"
	);

	tokio::fs::remove_dir_all(scratch("missing")).await.ok();
}
