import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dcb, globalApp } from "../misc";
import { readSetting } from "../setting";
import { nativeBinary } from "./nativeBinary";

/**
 * Downloads through the Rust fetcher (`rust/amhra-fetch`) instead of yt-dlp.
 *
 * The two differ in more than language. yt-dlp is piped: its stdout *is* the
 * audio, so the process, the file and the playing stream are one lifetime, and
 * a copy of every track is kept in memory to serve a second listener. The Rust
 * fetcher only writes files — `<id>.temp.music` while downloading, renamed to
 * `<id>.music` when whole, plus an `<id>.idx` seek index — and playback reads
 * them back with the follow-mode reader that already exists. Nothing is
 * buffered twice, and a download nobody is listening to costs no memory at all.
 *
 * It also downloads in ranges. An unranged YouTube GET is throttled to roughly
 * playback speed; the same file fetched as ranges arrives about a hundred times
 * faster.
 */

/** Enough of the file on disk that a reader will not immediately hit EOF */
const READY_BYTES = 32 * 1024;
/** How often the temp file is checked while waiting for those first bytes */
const POLL_INTERVAL_MS = 20;
/** Give up waiting for first bytes; the download itself keeps going */
const READY_TIMEOUT_MS = 15_000;

export interface NativeFetchResult {
	videoId: string;
	path: string;
	index: string | null;
	title: string | null;
	bytes: number;
	frames: number;
	durationMs: number;
	itag: number | null;
	source: "cache" | "innertube" | "yt-dlp";
	profile: string | null;
	elapsedMs: number;
	fallbackReason: string | null;
}

interface InFlight {
	/** Resolves when the download finishes and the file is renamed into place */
	promise: Promise<NativeFetchResult>;
	kill(): void;
}

const inFlight = new Map<string, InFlight>();

export const nativeFetchBin = nativeBinary(
	(setting) => setting.USE_NATIVE_FETCH,
	(setting) => setting.NATIVE_FETCH_BIN,
	"amhra-fetch",
);

/** Cancel every running download, for shutdown */
export function killNativeFetches() {
	for (const [id, entry] of inFlight) {
		dcb.log(`Killing native fetch: ${id}`);
		entry.kill();
	}
}

export function isFetching(id: string) {
	return inFlight.has(id);
}

/**
 * Start (or join) a download of `id`.
 *
 * Concurrent callers share one process: the second `play` of a track already
 * being fetched waits on the first rather than downloading it twice.
 */
export function nativeFetch(
	id: string,
	force = false,
): Promise<NativeFetchResult> {
	const existing = inFlight.get(id);
	if (existing && !force) return existing.promise;

	const binary = nativeFetchBin.path();
	const args = [id, "--cache-dir", `${process.cwd()}/cache`];
	if (force) args.push("--force");

	dcb.log(`Native fetch: ${id}`);
	const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
		// Progress lines are logged as they arrive rather than kept, so a long
		// download does not sit on a growing string.
		const lines = stderr.split("\n");
		stderr = lines.pop() ?? "";
		for (const line of lines) {
			if (line.trim()) dcb.log(`amhra-fetch ${id}: ${line.trim()}`);
		}
	});

	const promise = new Promise<NativeFetchResult>((resolve, reject) => {
		child.on("error", (error) => {
			globalApp.err(`Failed to run ${binary}`, error);
			reject(error);
		});
		child.on("close", (code) => {
			// The last line of stdout is the result object; anything before it
			// is not ours to interpret.
			const line = stdout.trim().split("\n").at(-1) ?? "";
			let parsed: (NativeFetchResult & { ok: boolean; error?: string }) | null =
				null;
			try {
				parsed = JSON.parse(line);
			} catch {
				parsed = null;
			}

			if (code !== 0 || !parsed?.ok) {
				const reason =
					parsed?.error ?? (stderr.trim() || `exit code ${code}`);
				globalApp.err(`Native fetch failed for ${id}: ${reason}`);
				return reject(new Error(`amhra-fetch failed for ${id}: ${reason}`));
			}

			dcb.log(
				`Native fetch done: ${id} via ${parsed.source} in ${parsed.elapsedMs}ms`,
			);
			if (parsed.fallbackReason) {
				globalApp.warn(
					`Native extraction fell back to yt-dlp for ${id}: ${parsed.fallbackReason}`,
				);
			}
			resolve(parsed);
		});
	});

	// Failures are reported by whoever awaits the promise; this keeps an
	// unawaited prefetch from surfacing as an unhandled rejection.
	promise.catch(() => {});
	promise.finally(() => {
		if (inFlight.get(id)?.promise === promise) inFlight.delete(id);
	});

	inFlight.set(id, { promise, kill: () => child.kill("SIGTERM") });
	return promise;
}

/**
 * Start a download and return once there is enough on disk to start playing.
 *
 * Playback follows the partial file, so waiting for the whole track would add
 * seconds of silence for no reason. Waiting for nothing at all would hand the
 * reader an empty file.
 */
export async function nativeFetchReady(
	id: string,
	force = false,
): Promise<NativeFetchResult | null> {
	const done = `${process.cwd()}/cache/${id}.music`;
	if (!force && existsSync(done)) return null;

	const promise = nativeFetch(id, force);
	const temp = `${process.cwd()}/cache/${id}.temp.music`;
	const deadline = Date.now() + READY_TIMEOUT_MS;

	for (;;) {
		const size = await stat(temp)
			.then((info) => info.size)
			.catch(() => 0);
		if (size >= READY_BYTES) return null;

		// A finished or failed download settles the question either way: the
		// file is complete, or the promise rejects and the caller hears why.
		const settled = await Promise.race([
			promise.then(
				(result) => ({ result }),
				(error: Error) => ({ error }),
			),
			new Promise<null>((resolve) =>
				setTimeout(() => resolve(null), POLL_INTERVAL_MS),
			),
		]);
		if (settled && "error" in settled) throw settled.error;
		if (settled && "result" in settled) return settled.result;

		if (Date.now() > deadline) {
			globalApp.warn(
				`Native fetch for ${id} produced no data in ${READY_TIMEOUT_MS}ms, playing anyway`,
			);
			return null;
		}
	}
}
