import { spawn } from "node:child_process";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	writeFileSync,
} from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extractID } from "play-dl";
import { dcb, globalApp } from "../misc";
import { updateLastUsed, reviewCaches } from "./cache";

if (!existsSync(`${process.cwd()}/data/lastUsed.record`)) {
	writeFileSync(`${process.cwd()}/data/lastUsed.record`, "");
}

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
 */
export async function prefetch(url: string, force = false) {
	const id = extractID(url);
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
		stdio: ["ignore", "pipe", "inherit"],
	});
	const rawOutputStream = spawnedProcess.stdout;
	const copiedStream = copyStreamSafe("prefetch", rawOutputStream);
	const writeStream = createWriteStream(
		`${process.cwd()}/cache/${id}.temp.music`,
	);
	const data: (string | Buffer)[] = [];
	rawOutputStream.pipe(writeStream);

	const promise = new Promise<void>((resolve, err) => {
		writeStream.on("close", async () => {
			dcb.log(`Download completed: ${id}`);
			streams.delete(id);
			if (existsSync(`${process.cwd()}/cache/${id}.temp.music`)) {
				await rename(
					`${process.cwd()}/cache/${id}.temp.music`,
					`${process.cwd()}/cache/${id}.music`,
				);
				await updateLastUsed([id]);
			} else {
				globalApp.warn(`Temp file not found: ${id}`);
			}
			await reviewCaches(streams.keys().toArray());
			resolve();
		});
		const errorHandler = async (error: NodeJS.ErrnoException) => {
			globalApp.err(`Write error: ${id}`, error);
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
		rawOutputStream.on("error", errorHandler);
		writeStream.on("error", errorHandler);
	});

	rawOutputStream.on("data", (chunk) => {
		data.push(chunk);
	});

	streams.set(id, {
		rawStream: rawOutputStream,
		promise,
		data,
	});
	await new Promise<void>((resolve) => {
		rawOutputStream.once("data", resolve);
	});

	return {
		rawOutputStream,
		copiedStream,
	};
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

export async function createYtDlpStream(
	url: string,
	force = false,
): Promise<Readable> {
	const id = extractID(url);
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
