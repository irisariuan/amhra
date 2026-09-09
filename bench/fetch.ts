import { existsSync, rmSync, statSync } from "node:fs";
import { peakRssMib, run, type Measurement } from "./lib";

/**
 * Compare the two downloaders on the same video.
 *
 * This one touches the network, so it is opt-in and its numbers move with the
 * link, the time of day, and whatever YouTube feels like doing. What does not
 * move is the shape of the difference: yt-dlp streams the file in one request
 * and is throttled to roughly playback speed, while the Rust fetcher asks for
 * ranges, which the same server answers at full speed.
 *
 * Both are run twice and the faster run of each is reported, so one unlucky
 * round trip does not decide the comparison.
 */

/** Creative Commons, long-lived, unlikely to be region-gated. */
const VIDEO = "dQw4w9WgXcQ";
const SCRATCH = `${process.cwd()}/.bench-cache`;

const RUST_BINARY = `${process.cwd()}/rust/target/release/amhra-fetch`;

function clean() {
	rmSync(SCRATCH, { recursive: true, force: true });
}

async function best(runs: number, body: () => Promise<{ ms: number; bytes: number }>) {
	let fastest = { ms: Number.POSITIVE_INFINITY, bytes: 0 };
	for (let i = 0; i < runs; i++) {
		clean();
		const result = await body();
		if (result.ms < fastest.ms) fastest = result;
	}
	return fastest;
}

export async function benchFetch(): Promise<{
	typescript: Measurement[];
	rust: Measurement[];
}> {
	const typescript: Measurement[] = [];
	const rust: Measurement[] = [];

	const ytdlp = await Bun.which("yt-dlp");
	if (ytdlp) {
		const result = await best(2, async () => {
			const target = `${SCRATCH}/${VIDEO}.music`;
			await Bun.write(target, "");
			// The exact invocation lib/voice/stream.ts uses.
			const proc = await run(
				[
					"sh",
					"-c",
					`yt-dlp 'https://www.youtube.com/watch?v=${VIDEO}' --format bestaudio -q --no-playlist --force-ipv4 -o - > '${target}'`,
				],
				{ quiet: true },
			);
			return {
				ms: proc.wallMs,
				bytes: existsSync(target) ? statSync(target).size : 0,
			};
		});
		typescript.push({
			name: "download_full_track",
			medianMs: result.ms,
			p95Ms: result.ms,
			mibPerSec: result.bytes / (1024 * 1024) / (result.ms / 1000),
			notes: `yt-dlp piped to disk, ${(result.bytes / 1024 / 1024).toFixed(1)} MiB`,
		});
	} else {
		console.log("yt-dlp is not installed; skipping its column");
	}

	if (existsSync(RUST_BINARY)) {
		const result = await best(2, async () => {
			const proc = await run(
				[RUST_BINARY, VIDEO, "--cache-dir", SCRATCH, "--force", "-q", "--no-fallback"],
				{ quiet: true },
			);
			const target = `${SCRATCH}/${VIDEO}.music`;
			return {
				ms: proc.wallMs,
				bytes: existsSync(target) ? statSync(target).size : 0,
			};
		});
		rust.push({
			name: "download_full_track",
			medianMs: result.ms,
			p95Ms: result.ms,
			mibPerSec: result.bytes / (1024 * 1024) / (result.ms / 1000),
			notes: `ranged requests, ${(result.bytes / 1024 / 1024).toFixed(1)} MiB, indexed while writing`,
		});

		// Peak memory, which is where a piped download and a ranged one differ
		// most: one holds the track in flight, the other holds four chunks.
		clean();
		const rss = await peakRssMib([
			RUST_BINARY,
			VIDEO,
			"--cache-dir",
			SCRATCH,
			"--force",
			"-q",
			"--no-fallback",
		]);
		if (!Number.isNaN(rss)) {
			rust.push({
				name: "download_peak_rss",
				medianMs: rss,
				p95Ms: rss,
				notes: "MiB, not milliseconds",
			});
		}
	} else {
		console.log(`${RUST_BINARY} is not built; skipping its column`);
	}

	if (ytdlp) {
		clean();
		const rss = await peakRssMib([
			"sh",
			"-c",
			`yt-dlp 'https://www.youtube.com/watch?v=${VIDEO}' --format bestaudio -q --no-playlist -o - > /dev/null`,
		]);
		if (!Number.isNaN(rss)) {
			typescript.push({
				name: "download_peak_rss",
				medianMs: rss,
				p95Ms: rss,
				notes: "MiB, not milliseconds — python interpreter included",
			});
		}
	}

	clean();
	return { typescript, rust };
}
