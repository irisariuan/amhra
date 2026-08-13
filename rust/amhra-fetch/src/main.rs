//! `amhra-fetch` — download a YouTube track into the bot's cache.
//!
//! Drop-in replacement for the `yt-dlp` spawn in `lib/voice/stream.ts`:
//! progress goes to stderr as plain lines, and the last line of stdout is a
//! single JSON object describing the result.
//!
//! ```text
//! amhra-fetch <url|video-id> [--cache-dir DIR] [--profiles FILE]
//!                            [--chunk-size BYTES] [--concurrency N]
//!                            [--no-fallback] [--force] [--quiet]
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

use amhra_fetch::{FetchOptions, FetchResult, download::DownloadOptions};

fn usage() -> ! {
	eprintln!(
		"usage: amhra-fetch <url|video-id> [--cache-dir DIR] [--profiles FILE]\n\
		 \x20                  [--chunk-size BYTES] [--concurrency N] [--no-fallback]\n\
		 \x20                  [--force] [--quiet]"
	);
	std::process::exit(2)
}

struct Args {
	input: String,
	options: FetchOptions,
	quiet: bool,
}

fn parse_args() -> Args {
	let mut input: Option<String> = None;
	let mut download = DownloadOptions::default();
	let mut cache_dir = amhra_fetch::default_cache_dir();
	let mut profiles: Option<PathBuf> = None;
	let mut allow_fallback = true;
	let mut force = false;
	let mut quiet = false;

	let mut args = std::env::args().skip(1);
	while let Some(arg) = args.next() {
		let mut value = |name: &str| args.next().unwrap_or_else(|| {
			eprintln!("{name} needs a value");
			usage()
		});
		match arg.as_str() {
			"--cache-dir" => cache_dir = PathBuf::from(value("--cache-dir")),
			"--profiles" => profiles = Some(PathBuf::from(value("--profiles"))),
			"--chunk-size" => {
				download.chunk_size = value("--chunk-size").parse().unwrap_or_else(|_| usage())
			}
			"--concurrency" => {
				download.concurrency = value("--concurrency").parse().unwrap_or_else(|_| usage())
			}
			"--attempts" => {
				download.attempts = value("--attempts").parse().unwrap_or_else(|_| usage())
			}
			"--no-fallback" => allow_fallback = false,
			"--force" => force = true,
			"--quiet" | "-q" => quiet = true,
			"--help" | "-h" => usage(),
			other if other.starts_with('-') => {
				eprintln!("unknown option: {other}");
				usage()
			}
			other => input = Some(other.to_owned()),
		}
	}

	if download.concurrency == 0 || download.chunk_size == 0 {
		eprintln!("--concurrency and --chunk-size must be positive");
		usage()
	}

	Args {
		input: input.unwrap_or_else(|| usage()),
		options: FetchOptions { cache_dir, profiles, download, allow_fallback, force },
		quiet,
	}
}

fn as_json(result: &FetchResult) -> String {
	let escape = |text: &str| serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned());
	let mut out = String::from("{");
	out.push_str(&format!("\"ok\":true,\"videoId\":{}", escape(&result.video_id)));
	out.push_str(&format!(",\"path\":{}", escape(&result.path.to_string_lossy())));
	match &result.index_path {
		Some(path) => out.push_str(&format!(",\"index\":{}", escape(&path.to_string_lossy()))),
		None => out.push_str(",\"index\":null"),
	}
	match &result.title {
		Some(title) => out.push_str(&format!(",\"title\":{}", escape(title))),
		None => out.push_str(",\"title\":null"),
	}
	out.push_str(&format!(",\"bytes\":{}", result.bytes));
	out.push_str(&format!(",\"frames\":{}", result.frames));
	out.push_str(&format!(",\"durationMs\":{}", result.duration_ms));
	match result.itag {
		Some(itag) => out.push_str(&format!(",\"itag\":{itag}")),
		None => out.push_str(",\"itag\":null"),
	}
	out.push_str(&format!(",\"source\":{}", escape(result.source.as_str())));
	match &result.profile {
		Some(profile) => out.push_str(&format!(",\"profile\":{}", escape(profile))),
		None => out.push_str(",\"profile\":null"),
	}
	out.push_str(&format!(",\"elapsedMs\":{}", result.elapsed_ms));
	match &result.fallback_reason {
		Some(reason) => out.push_str(&format!(",\"fallbackReason\":{}", escape(reason))),
		None => out.push_str(",\"fallbackReason\":null"),
	}
	out.push('}');
	out
}

#[tokio::main]
async fn main() -> ExitCode {
	let args = parse_args();

	// Progress is reported at most once per 5% so a long track does not flood
	// the log the bot writes every line of to disk.
	let mut last_reported = 0u64;
	let quiet = args.quiet;
	let on_progress = move |done: u64, total: u64| {
		if quiet || total == 0 {
			return;
		}
		let percent = done * 100 / total;
		if percent >= last_reported + 5 || done == total {
			last_reported = percent;
			eprintln!("progress {percent}% ({done}/{total})");
		}
	};

	match amhra_fetch::fetch(&args.input, &args.options, on_progress).await {
		Ok(result) => {
			if !args.quiet {
				eprintln!(
					"{} via {} in {}ms ({} bytes, {} frames)",
					result.video_id,
					result.source.as_str(),
					result.elapsed_ms,
					result.bytes,
					result.frames
				);
			}
			println!("{}", as_json(&result));
			ExitCode::SUCCESS
		}
		Err(error) => {
			let message = serde_json::to_string(&error.to_string())
				.unwrap_or_else(|_| "\"unknown error\"".to_owned());
			println!("{{\"ok\":false,\"error\":{message}}}");
			eprintln!("fetch failed: {error}");
			ExitCode::FAILURE
		}
	}
}
