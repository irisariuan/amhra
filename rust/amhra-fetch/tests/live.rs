//! Tests that talk to YouTube.
//!
//! Ignored by default: they depend on a third party that rate-limits, bot-checks
//! and changes its client requirements without notice, so a red run here means
//! "go look", not "the build is broken". Run them deliberately:
//!
//! ```text
//! cargo test -p amhra-fetch --test live -- --ignored --nocapture
//! ```

use std::path::PathBuf;

use amhra_fetch::innertube::{Extractor, load_profiles};

/// Creative Commons, long-lived, and not age- or region-gated.
const VIDEO: &str = "dQw4w9WgXcQ";

fn scratch_dir(name: &str) -> PathBuf {
	let mut path = std::env::temp_dir();
	path.push(format!("amhra-live-{name}-{}", std::process::id()));
	path
}

#[tokio::test]
#[ignore = "talks to YouTube"]
async fn a_profile_still_yields_a_direct_opus_url() {
	let profiles = load_profiles(None).expect("profiles parse");
	let extractor = Extractor::new(profiles).expect("client builds");
	let extraction = extractor.extract(VIDEO).await.expect("some profile works");

	println!("served by profile: {}", extraction.profile);
	assert!(extraction.format.mime_type.contains("opus"));
	assert!(extraction.format.url.starts_with("https://"));
	assert!(extraction.format.content_length > 0, "no contentLength to range over");
	// The whole point of the token-free ladder: no `n` parameter means no
	// player-JS descrambling. If this ever fails, the nsig work is due.
	assert!(
		!extraction.format.url.contains("&n="),
		"URL carries an n parameter and now needs descrambling"
	);
}

#[tokio::test]
#[ignore = "talks to YouTube"]
async fn a_full_fetch_produces_a_playable_indexed_file() {
	let cache = scratch_dir("fetch");
	tokio::fs::create_dir_all(&cache).await.expect("scratch dir");

	let options = amhra_fetch::FetchOptions {
		cache_dir: cache.clone(),
		profiles: None,
		download: Default::default(),
		allow_fallback: false,
		force: true,
	};
	let result = amhra_fetch::fetch(VIDEO, &options, |_, _| {}).await.expect("fetch succeeds");

	println!("{} bytes in {}ms via {}", result.bytes, result.elapsed_ms, result.source.as_str());
	assert!(result.bytes > 100_000);
	assert!(result.frames > 1_000);
	assert!(result.duration_ms > 200_000);

	// The index must describe the file that was actually written.
	let index = amhra_audio::Index::open(&result.index_path.expect("indexed")).unwrap();
	let header = index.header();
	assert!(header.complete);
	assert_eq!(header.channels, 2);
	assert_eq!(header.sample_rate, 48_000);
	assert!(index.len() > 100, "expected roughly one entry per second");

	// Every indexed offset has to land on a real Opus packet.
	let music = std::fs::read(&result.path).unwrap();
	for position in [0, index.len() / 2, index.len() - 1] {
		let entry = index.get(position).unwrap();
		let toc = music[entry.offset as usize];
		assert!(
			amhra_audio::packet_info(&music[entry.offset as usize..]).is_some(),
			"entry {position} points at {toc:#x}, not an Opus packet"
		);
	}

	tokio::fs::remove_dir_all(&cache).await.ok();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "talks to YouTube"]
async fn two_fetches_of_one_track_do_not_trip_over_each_other() {
	let cache = scratch_dir("race");
	tokio::fs::create_dir_all(&cache).await.expect("scratch dir");

	// Forced, so both miss the cache and both go for `<id>.temp.music` — the
	// second used to fail when the first renamed it out from under it.
	let options = amhra_fetch::FetchOptions {
		cache_dir: cache.clone(),
		profiles: None,
		download: Default::default(),
		allow_fallback: false,
		force: true,
	};
	let (first, second) = tokio::join!(
		amhra_fetch::fetch(VIDEO, &options, |_, _| {}),
		amhra_fetch::fetch(VIDEO, &options, |_, _| {}),
	);
	let (first, second) = (first.expect("first fetch"), second.expect("second fetch"));

	// One downloaded; the other waited and took the result as a cache hit.
	let mut sources = [first.source.as_str(), second.source.as_str()];
	sources.sort();
	assert_eq!(sources, ["cache", "innertube"]);
	assert_eq!(first.bytes, second.bytes);
	assert!(!cache.join(format!("{VIDEO}.temp.music")).exists());

	tokio::fs::remove_dir_all(&cache).await.ok();
}

#[tokio::test]
#[ignore = "talks to YouTube"]
async fn a_stream_plays_from_memory() {
	let profiles = load_profiles(None).expect("profiles parse");
	let extractor = Extractor::new(profiles).expect("client builds");
	let (mut writer, feed) = amhra_audio::stream::channel();
	let mut reader = amhra_audio::CacheReader::streaming(feed);

	let streamed = amhra_fetch::stream(VIDEO, &extractor, Default::default(), &mut writer)
		.await
		.expect("the stream completes");
	drop(writer);
	println!("{} bytes via {}", streamed.bytes, streamed.profile);

	reader.refresh().expect("the bytes demux");
	assert!(reader.is_complete());
	let mut frames = 0;
	while reader.next_frame().is_some() {
		frames += 1;
	}
	assert!(frames > 1_000, "only {frames} frames came through");
	assert_eq!(reader.seek(0), 0, "a played stream can still seek back");
}
