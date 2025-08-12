import moment from "moment";
import { spawn } from "node:child_process";
import { PassThrough, Readable, type Writable } from "node:stream";
import { extractID } from "play-dl";
import {
	createWriteStream,
	existsSync,
	createReadStream,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { readFile, writeFile, stat, unlink, rename } from "node:fs/promises";
import { readSetting } from "../setting";
import { dcb, globalApp } from "../misc";
import { pipeline } from "node:stream/promises";

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
			await unlink(`${process.cwd()}/cache/${id}.temp.music`).catch();
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

async function reviewCaches(forceReview = false) {
	const maxSize = readSetting().MAX_CACHE_IN_GB * 1024 * 1024 * 1024;
	let { size } = await stat(`${process.cwd()}/cache`);
	if (size < maxSize && !forceReview) return;
	dcb.log(`Reviewing caches, cache size: ${size} / ${maxSize}`);
	const data = (
		await readFile(`${process.cwd()}/data/lastUsed.record`, "utf8")
	).split("\n");
	const actualCaches = readdirSync(`${process.cwd()}/cache`);
	const deletedFiles = [];
	for (const line of data) {
		const [id, lastUsedStr] = line.split("=");
		const lastUsed = Number(lastUsedStr);
		if (actualCaches.includes(`${id}.music`)) {
			const metadata = await stat(`${process.cwd()}/cache/${id}.music`);
			if (
				metadata.size === 0 ||
				(size >= maxSize &&
					!forceReview &&
					lastUsed < Date.now() - 1000 * 60 * 60 * 24)
			) {
				dcb.log(`Deleting cache: ${id}`);
				unlink(`${process.cwd()}/cache/${id}.music`).catch();
				size -= metadata.size;
				deletedFiles.push(id);
			}
		} else {
			deletedFiles.push(id);
		}
	}
	await updateLastUsed([], deletedFiles).catch(() => {});
}

async function updateLastUsed(updateIds: string[], deleteIds?: string[]) {
	const data = (
		await readFile(`${process.cwd()}/data/lastUsed.record`, "utf8")
	).split("\n");
	(() => {
		if (!updateIds.length) return;
		for (let i = 0; i < data.length; i++) {
			const line = data[i];
			for (const id of updateIds) {
				if (line.startsWith(id)) {
					data[i] = `${id}=${Date.now()}`;
					return;
				}
			}
		}
		data.push(`${updateIds}=${Date.now()}`);
	})();
	(() => {
		if (!deleteIds?.length) return;
		for (let i = 0; i < data.length; i++) {
			const line = data[i];
			for (const id of deleteIds) {
				if (line.startsWith(id)) {
					data.splice(i, 1);
					return;
				}
			}
		}
	})();
	return await writeFile(
		`${process.cwd()}/data/lastUsed.record`,
		data.join("\n"),
	);
}

function parseTime(seek: number) {
	const time = moment(seek);
	const str =
		seek >= 60 * 60 * 60 ? time.format("HH:mm:ss") : time.format("mm:ss");
	return `*${str}-inf`;
}

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
			await reviewCaches();
			resolve();
		});

		writeStream.on("error", async (error) => {
			globalApp.err(`Write error: ${id}`, error);
			streams.delete(id);
			if (existsSync(`${process.cwd()}/cache/${id}.temp.music`)) {
				globalApp.err(
					`Deleting ${id}.temp.music due to ${error.message}`,
				);
				await unlink(`${process.cwd()}/cache/${id}.temp.music`).catch();
			}

			if (existsSync(`${process.cwd()}/cache/${id}.music`)) {
				globalApp.err(`Deleting ${id}.music due to ${error.message}`);
				await unlink(`${process.cwd()}/cache/${id}.music`).catch();
			}
			await updateLastUsed([], [id]);
			await reviewCaches();
			err(error);
		});
	});

	rawOutputStream.on("data", (chunk) => {
		data.push(chunk);
	});

	streams.set(id, {
		rawStream: rawOutputStream,
		promise,
		data,
	});
	return { rawOutputStream, copiedStream: copyStreamSafe(rawOutputStream) };
}

function copyStreamSafe(
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
			globalApp.warn(`Copied stream not writable: ${data}`);
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
		copied: copyStreamSafe(proc.stdout),
		proc,
	};
}

export async function createYtDlpStream(
	url: string,
	force = false,
): Promise<Readable> {
	const id = extractID(url);
	const fetchedStream = streams.get(id);
	if (fetchedStream && !fetchedStream.rawStream?.readable && !force) {
		// it is still being fetched or already fetched in current process
		dcb.log(`Stream hit memory: ${id}`);
		const readable = new Readable();
		for (const chunk of fetchedStream.data) {
			readable.push(chunk);
		}
		// all data is already in memory, so we can just end the stream by pushing null
		readable.push(null);
		return readable;
	}
	// Check if the file is already cached (fetched in previous process)
	if (existsSync(`${process.cwd()}/cache/${id}.music`) && !force) {
		return await getCachedStream(id);
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
			return copyStreamSafe(resultStream.rawStream, resultStream.data);
		}
		if (existsSync(`${process.cwd()}/cache/${id}.music`)) {
			return await getCachedStream(id);
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

async function getCachedStream(id: string) {
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
	return stream;
}
