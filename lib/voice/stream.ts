import { spawn } from "node:child_process";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	writeFileSync,
} from "node:fs";
import {
	open,
	rename,
	stat,
	unlink,
	type FileHandle,
} from "node:fs/promises";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getYouTubeVideoId } from "../youtube";
import { dcb, globalApp } from "../misc";
import { collectOrphanedTemps, updateLastUsed, reviewCaches } from "./cache";
import { CHANNELS, SAMPLE_RATE } from "./opus";

if (!existsSync(`${process.cwd()}/data/lastUsed.record`)) {
	writeFileSync(`${process.cwd()}/data/lastUsed.record`, "");
}

// Nothing can be downloading yet, so every temp file present at startup is
// left over from a run that did not shut down cleanly
collectOrphanedTemps().catch(() => {});

interface YtDlpStream {
	rawStream?: Readable;
	promise: Promise<void>;
	data: (string | Buffer)[];
}

const streams = new Map<string, YtDlpStream>();

async function closeAllStreams() {
	globalApp.important("Closing all streams");
	for (const [id, stream] of streams) {
		if (stream.rawStream?.destroyed) continue;
		dcb.log(`Killing stream: ${id}`);
		stream.rawStream?.destroy(new Error("Force stream closed"));
		if (existsSync(`${process.cwd()}/cache/${id}.temp.music`)) {
			dcb.log(`Deleting temp file: ${id}`);
			await unlink(`${process.cwd()}/cache/${id}.temp.music`).catch(
				() => {},
			);
		}
		dcb.log(`Stream finished: ${id}`);
	}
	globalApp.important("All streams closed");
}

process.on("beforeExit", async (code) => {
	if (code === 64) return;
	globalApp.important("Process exiting, closing all streams");
	await closeAllStreams();
	process.exit(64);
});
process.on("SIGINT", async () => {
	await closeAllStreams();
	process.exit(64);
});

/**
 * Return the streams from yt-dlp, pre-streamed to file
 * Used for prefetching earlier or get the prefetching/fetched stream
 */
export async function prefetch(url: string, force = false) {
	const id = getYouTubeVideoId(url);
	if (!id) throw new Error(`Invalid YouTube video URL: ${url}`);
	const processedUrl = `https://www.youtube.com/watch?v=${id}`;
	if (
		(existsSync(`${process.cwd()}/cache/${id}.music`) || streams.has(id)) &&
		!force
	) {
		dcb.log(`Cache hit: ${id}, skipping prefetch`);
		return;
	}

	const args = [
		processedUrl,
		"--format",
		"bestaudio",
		"-q",
		"--no-playlist",
		"--force-ipv4",
		"-o",
		"-",
	];

	dcb.log(`Downloading: ${id} (yt-dlp ${args.join(" ")})`);
	const spawnedProcess = spawn("yt-dlp", args, {
		stdio: ["ignore", "pipe", "pipe"],
	});

	// Captured so a failure can say why. yt-dlp runs with -q, so this is quiet
	// unless something actually went wrong.
	let stderr = "";
	spawnedProcess.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	/** yt-dlp's exit code, awaited before a download is trusted */
	const exitCode = new Promise<number | null>((resolve) => {
		spawnedProcess.on("close", resolve);
	});
	const rawOutputStream = spawnedProcess.stdout;
	const copiedStream = copyStreamSafe("prefetch", rawOutputStream);
	const writeStream = createWriteStream(
		`${process.cwd()}/cache/${id}.temp.music`,
	);
	
	// Collect data chunks for in-memory caching
	const data: (string | Buffer)[] = [];
	rawOutputStream.pipe(writeStream);
	rawOutputStream.on("data", (chunk) => {
		data.push(chunk);
	});
	
	// Handle errors and completion
	const promise = new Promise<void>((resolve, err) => {
		const errorHandler = async (error: NodeJS.ErrnoException) => {
			rawOutputStream.destroy();
			writeStream.destroy();
			globalApp.err(`Error occurred while prefetching ${id}`, error);
			streams.delete(id);
			if (existsSync(`${process.cwd()}/cache/${id}.temp.music`)) {
				globalApp.err(
					`Deleting ${id}.temp.music due to ${error.message}`,
				);
				await unlink(`${process.cwd()}/cache/${id}.temp.music`).catch(
					() => {},
				);
			}

			if (existsSync(`${process.cwd()}/cache/${id}.music`)) {
				globalApp.err(`Deleting ${id}.music due to ${error.message}`);
				await unlink(`${process.cwd()}/cache/${id}.music`).catch(
					() => {},
				);
			}
			await updateLastUsed([], [id]);
			await reviewCaches(streams.keys().toArray());
			err(error);
		};
		writeStream.on("close", async () => {
			streams.delete(id);
			const temp = `${process.cwd()}/cache/${id}.temp.music`;
			if (!existsSync(temp)) {
				globalApp.warn(`Temp file not found: ${id}`);
				await reviewCaches(streams.keys().toArray());
				return resolve();
			}

			// stdout closing only means yt-dlp stopped writing, not that it
			// succeeded. Without this a failed download (403, geo-block, a dead
			// video) is renamed into the cache as a valid entry, and every later
			// play of that id is served an empty file instead of retrying.
			const code = await exitCode;
			const written = await stat(temp)
				.then((info) => info.size)
				.catch(() => 0);
			if (code !== 0 || written === 0) {
				globalApp.err(
					`Download failed for ${id} (exit ${code}, ${written} bytes)${
						stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""
					}`,
				);
				await unlink(temp).catch(() => {});
				await updateLastUsed([], [id]);
				await reviewCaches(streams.keys().toArray());
				return err(
					new Error(`yt-dlp failed for ${id} (exit ${code})`),
				);
			}

			dcb.log(`Download completed: ${id} (${written} bytes)`);
			await rename(temp, `${process.cwd()}/cache/${id}.music`);
			await updateLastUsed([id]);
			await reviewCaches(streams.keys().toArray());
			resolve();
		});

		rawOutputStream.on("error", errorHandler);
		writeStream.on("error", errorHandler);
		spawnedProcess.on("error", errorHandler);
	});

	// Nothing awaits this: callers are handed the stream, not the completion.
	// The failure is already logged where it happens, so mark it handled rather
	// than letting it resurface as an unhandled rejection.
	promise.catch(() => {});

	streams.set(id, {
		rawStream: rawOutputStream,
		promise,
		data,
	});
	
	// Wait for the first data chunk to ensure the stream is active. A download
	// that fails before writing anything never emits one, so end/error/exit have
	// to release this too or the caller waits forever.
	await new Promise<void>((resolve) => {
		rawOutputStream.once("data", resolve);
		rawOutputStream.once("end", resolve);
		rawOutputStream.once("error", resolve);
		spawnedProcess.once("close", resolve);
	});

	return {
		rawOutputStream,
		copiedStream,
	};
}

/** First element of any Matroska/WebM file */
const EBML_MAGIC = 0x1a45dfa3;

/**
 * Open the on-disk copy of a track, whichever name it currently has.
 *
 * Resolved on every call rather than cached: a download completing renames
 * `.temp.music` to `.music`, so a path captured earlier can vanish. Seeking
 * backwards into a partial file is safe, because anything already played has
 * by definition already been written.
 */
export function openCacheStream(id: string, follow = false): Readable | null {
	const done = `${process.cwd()}/cache/${id}.music`;
	// A finished download is a plain file; nothing can be appended to it
	if (existsSync(done)) return createReadStream(done);

	const partial = `${process.cwd()}/cache/${id}.temp.music`;
	if (!existsSync(partial)) return null;
	if (!follow) return createReadStream(partial);
	return new TailFileStream(partial);
}

/** How often a tailed file is re-checked for new bytes */
const TAIL_POLL_MS = 100;
/** Give up on a partial file that stops growing for this long */
const TAIL_IDLE_MS = 30_000;

/**
 * Reads a file that is still being written, blocking at the end instead of
 * reporting EOF.
 *
 * This is what makes a livestream work: the download never finishes, so the
 * cache file is the only complete record of it and playback has to follow the
 * writer rather than race it to the end.
 *
 * The descriptor is opened once and kept, so the `.temp.music` to `.music`
 * rename at the end of a download does not interrupt reading. Whether more is
 * coming is decided from the descriptor's own size, never from the path, so a
 * write landing between a read and the rename cannot be lost.
 */
class TailFileStream extends Readable {
	private handle: FileHandle | null = null;
	private offset = 0;
	private idle = 0;
	private busy = false;

	constructor(private readonly path: string) {
		super();
	}

	async _read(size: number) {
		// _read can fire again while the previous await chain is still running
		if (this.busy) return;
		this.busy = true;
		try {
			if (!this.handle) this.handle = await open(this.path, "r");
			const buffer = Buffer.allocUnsafe(Math.max(size, 64 * 1024));
			for (;;) {
				if (this.destroyed) return;
				const { size: current } = await this.handle.stat();
				if (this.offset < current) {
					const { bytesRead } = await this.handle.read(
						buffer,
						0,
						Math.min(buffer.length, current - this.offset),
						this.offset,
					);
					if (bytesRead > 0) {
						this.offset += bytesRead;
						this.idle = 0;
						this.push(Buffer.from(buffer.subarray(0, bytesRead)));
						return;
					}
				}
				// Drained to the current end. The writer renames the file away
				// once it is done, so a missing path means no more is coming.
				if (!existsSync(this.path)) return void this.push(null);
				await new Promise((r) => setTimeout(r, TAIL_POLL_MS));
				this.idle += TAIL_POLL_MS;
				if (this.idle >= TAIL_IDLE_MS) {
					globalApp.warn(
						`Tailed cache file stopped growing, ending: ${this.path}`,
					);
					return void this.push(null);
				}
			}
		} catch (error) {
			this.destroy(error as Error);
		} finally {
			this.busy = false;
		}
	}

	_destroy(error: Error | null, callback: (error: Error | null) => void) {
		this.handle?.close().catch(() => {});
		this.handle = null;
		callback(error);
	}
}

/**
 * Look at the first chunk to decide whether the source is WebM, then hand back
 * a stream that still starts at byte zero.
 *
 * yt-dlp's `bestaudio` is WebM/Opus for effectively every YouTube video, but
 * not quite all of them, so the ffmpeg path stays as a fallback.
 */
export async function peekWebm(
	source: Readable,
): Promise<{ isWebm: boolean; stream: Readable }> {
	const head = await new Promise<Buffer | null>((resolve) => {
		const cleanup = () => {
			source.off("data", onData);
			source.off("end", onEnd);
			source.off("error", onEnd);
			source.pause();
		};
		const onData = (chunk: Buffer) => {
			cleanup();
			resolve(chunk);
		};
		const onEnd = () => {
			cleanup();
			resolve(null);
		};
		source.once("data", onData);
		source.once("end", onEnd);
		source.once("error", onEnd);
	});

	const isWebm =
		!!head && head.length >= 4 && head.readUInt32BE(0) === EBML_MAGIC;

	// Put the consumed chunk back in front of the rest
	const stream = new PassThrough();
	if (head) stream.write(head);
	source.pipe(stream);
	return { isWebm, stream };
}

function copyStreamSafe(
	tag: string,
	rawStream: Readable,
	preData?: (string | Buffer<ArrayBufferLike>)[],
): Readable {
	const passThrough = new PassThrough();
	if (preData) {
		for (const data of preData) {
			passThrough.write(data);
		}
	}
	const dataHandler = (data: any) => {
		if (!passThrough.writable) {
			globalApp.warn("Copied stream not writable, called by " + tag);
			return rawStream.removeListener("data", dataHandler);
		}
		passThrough.write(data);
	};
	rawStream.on("data", dataHandler);
	rawStream.on("end", () => {
		if (!passThrough.writableEnded) passThrough.end();
	});
	rawStream.on("error", (err) => {
		globalApp.err(`Copied stream error: ${err.message}`);
		passThrough.destroy(err);
	});
	return passThrough;
}

/**
 * Decode any container/codec ffmpeg understands into raw signed 16-bit
 * little-endian PCM at the Discord sample rate.
 *
 * The returned stream is left in paused mode on purpose: whoever consumes it
 * pulls one Opus frame at a time, which keeps the un-adjusted audio in
 * ffmpeg's output buffer instead of downstream of the volume stage.
 */
export function decodeToPcm(source: Readable) {
	const args = [
		"-loglevel",
		"error",
		"-i",
		"pipe:0",
		"-vn",
		"-f",
		"s16le",
		"-ar",
		SAMPLE_RATE.toString(),
		"-ac",
		CHANNELS.toString(),
		"pipe:1",
	];

	const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });

	const decoder = new TextDecoder();
	proc.stderr.on("data", (buf) =>
		globalApp.err(`FFmpeg decode: ${decoder.decode(buf).trim()}`),
	);
	proc.on("error", (err) =>
		globalApp.err(`FFmpeg decode process error: ${err.message}`),
	);

	const kill = () => {
		if (proc.exitCode === null && !proc.killed) proc.kill("SIGKILL");
	};
	proc.stdout.on("close", kill);

	source.on("error", (err: NodeJS.ErrnoException) => {
		globalApp.err(`Decode source error: ${err.message}`);
		kill();
	});
	// Skip pipeline(): a killed ffmpeg makes stdin throw EPIPE, which is
	// expected whenever playback is stopped early
	source.pipe(proc.stdin);
	proc.stdin.on("error", () => source.destroy());

	return { stream: proc.stdout, proc, kill };
}

export function clipAudio(source: Readable, start: number, end?: number) {
	if (start < 0) {
		throw new Error("Period start must be non-negative.");
	}
	if (end !== undefined && end <= 0) {
		throw new Error("Period end must be greater than zero.");
	}

	const args = [
		"-i",
		"pipe:0",
		"-ss",
		start.toString(),
		...(end ? ["-to", end.toString()] : []),
		"-c",
		"copy",
		"-c:a",
		"libopus",
		"-f",
		"webm",
		"pipe:1",
	];

	const proc = spawn("ffmpeg", args, {
		stdio: ["pipe", "pipe", "pipe"],
	});

	let buffer = Buffer.from([]);
	proc.stdout.on("data", (buf) => {
		buffer = Buffer.concat([buffer, buf]);
	});
	const decoder = new TextDecoder();
	let logMessage = "";
	proc.stderr.on("data", (buf) => {
		logMessage += decoder.decode(buf);
	});
	proc.on("error", (err) => {
		globalApp.err(`FFmpeg process error: ${err.message}`);
		globalApp.err(`Runtime message following:\n${logMessage}`);
	});

	const promise = new Promise<Buffer>((resolve) =>
		proc.stdout.on("close", () => {
			resolve(buffer);
		}),
	);

	pipeline(source, proc.stdin).catch((err: NodeJS.ErrnoException) =>
		globalApp.err(`Pipeline error: ${err.message}`),
	);
	return {
		buffer: promise,
		copied: copyStreamSafe("clipAudio", proc.stdout),
		proc,
	};
}

/*
 * Create a Readable stream from yt-dlp, with caching
 */
export async function createYtDlpStream(
	url: string,
	force = false,
): Promise<Readable> {
	const id = getYouTubeVideoId(url);
	if (!id) throw new Error(`Invalid YouTube video URL: ${url}`);
	const fetchedStream = streams.get(id);
	if (fetchedStream && !force) {
		// it is still being fetched or already fetched in current process
		dcb.log(`Stream hit memory: ${id}`);
		const readable = new Readable();
		for (const chunk of fetchedStream.data) {
			readable.push(chunk);
		}
		// all data is already in memory, so we can just end the stream by pushing null
		if (fetchedStream.rawStream?.closed) {
			readable.push(null);
			return readable;
		}
		fetchedStream.rawStream?.on("data", (chunk) => {
			readable.push(chunk);
		});
		fetchedStream.rawStream?.on("end", () => {
			readable.push(null);
		});
		return readable;
	}
	// Check if the file is already cached (fetched in previous process)
	if (existsSync(`${process.cwd()}/cache/${id}.music`) && !force) {
		return await getFileCachedStream(id);
	}
	// Cache miss, we need to download the file
	dcb.log(`Cache miss: ${id}, downloading...`);
	const resultStream = await prefetch(url, force);
	if (!resultStream) {
		dcb.log(
			`Failed to create stream (cached already or downloading): ${id}`,
		);
		const resultStream = streams.get(id);
		if (resultStream?.rawStream) {
			return copyStreamSafe(
				"createYtDlpStream (Cached or downloading)",
				resultStream.rawStream,
				resultStream.data,
			);
		}
		if (existsSync(`${process.cwd()}/cache/${id}.music`)) {
			return await getFileCachedStream(id);
		}
		throw new Error(
			`Failed to create stream (cached already or downloading): ${id}`,
		);
	}
	const { copiedStream } = resultStream;
	if (!copiedStream?.readable) {
		dcb.log(`Stream not found or not readable: ${id}`);
		throw new Error(`Stream not found or not readable: ${id}`);
	}
	return copiedStream;
}

async function getFileCachedStream(id: string) {
	dcb.log(`Cache hit: ${id}`);
	await updateLastUsed([id]);
	const stream = createReadStream(`${process.cwd()}/cache/${id}.music`);
	const data: (string | Buffer)[] = [];
	stream.on("data", (chunk) => data.push(chunk));
	const promise = new Promise<void>((r) => stream.on("end", r));
	streams.set(id, {
		promise,
		rawStream: stream,
		data,
	});
	dcb.log(`Stream created: ${id}`);
	return copyStreamSafe("getFileCachedStream", stream, data);
}
