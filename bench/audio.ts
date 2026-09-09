import crypto from "node:crypto";
import { WebmOpusDemuxer } from "../lib/voice/webm";
import { CHANNELS, FRAME_BYTES, SAMPLE_RATE, createOpusEngine } from "../lib/voice/opus";
import { bytesToMib, measure, perFrame, type Measurement } from "./lib";

/**
 * The TypeScript half of the audio benchmarks.
 *
 * Each measurement mirrors one in rust/amhra-{audio,voice}/examples/bench.rs so
 * the two are doing the same work on the same file. Where the current pipeline
 * has no equivalent — it has no passthrough, because it always decodes — that
 * is recorded as an absence rather than left out, since the absence is the
 * point.
 */

/** Pull every Opus packet out of a cache file. */
export async function loadFrames(file: string) {
	const bytes = Buffer.from(await Bun.file(file).arrayBuffer());
	const demuxer = new WebmOpusDemuxer();
	const frames: Buffer[] = [];
	const done = new Promise<void>((resolve, reject) => {
		demuxer.on("data", (packet: Buffer) => frames.push(packet));
		demuxer.on("end", resolve);
		demuxer.on("error", reject);
	});
	demuxer.end(bytes);
	await done;
	return { bytes, frames };
}

function demuxOnce(bytes: Buffer, chunkSize?: number) {
	return new Promise<number>((resolve, reject) => {
		const demuxer = new WebmOpusDemuxer();
		let count = 0;
		demuxer.on("data", () => count++);
		demuxer.on("end", () => resolve(count));
		demuxer.on("error", reject);
		if (chunkSize === undefined) {
			demuxer.end(bytes);
			return;
		}
		for (let offset = 0; offset < bytes.length; offset += chunkSize) {
			demuxer.write(bytes.subarray(offset, offset + chunkSize));
		}
		demuxer.end();
	});
}

export async function benchDemux(file: string): Promise<Measurement[]> {
	const { bytes, frames } = await loadFrames(file);
	const mib = bytesToMib(bytes.length);

	const whole = await measure(20, () => demuxOnce(bytes));
	const chunked = await measure(20, () => demuxOnce(bytes, 256 * 1024));

	return [
		{
			name: "demux_whole_file",
			...whole,
			mibPerSec: mib / (whole.medianMs / 1000),
			notes: `${frames.length} frames, ${mib.toFixed(1)} MiB`,
		},
		{
			name: "demux_256k_chunks",
			...chunked,
			mibPerSec: mib / (chunked.medianMs / 1000),
		},
	];
}

/**
 * Transport encryption as @discordjs/voice performs it: an RTP header as
 * additional data, a 32-bit counter at the front of a zero-filled nonce, and
 * the counter repeated after the ciphertext.
 */
export async function benchCrypto(frames: Buffer[]): Promise<Measurement[]> {
	const key = Buffer.alloc(32, 7);
	const rtpHeader = Buffer.alloc(12);
	rtpHeader[0] = 0x80;
	rtpHeader[1] = 0x78;
	const nonceBuffer = Buffer.alloc(12);
	let nonce = 0;
	let cursor = 0;
	let sequence = 0;
	let timestamp = 0;

	const aes = await perFrame(10, 5_000, () => {
		const frame = frames[cursor++ % frames.length];
		rtpHeader.writeUInt16BE(++sequence & 0xffff, 2);
		rtpHeader.writeUInt32BE((timestamp += 960) >>> 0, 4);
		nonceBuffer.writeUInt32BE(++nonce >>> 0, 0);

		const cipher = crypto.createCipheriv("aes-256-gcm", key, nonceBuffer);
		cipher.setAAD(rtpHeader);
		Buffer.concat([
			rtpHeader,
			cipher.update(frame),
			cipher.final(),
			cipher.getAuthTag(),
			nonceBuffer.subarray(0, 4),
		]);
	});

	return [
		{
			name: "transport_aes256_gcm",
			...aes,
			notes: "node crypto, as @discordjs/voice does it",
		},
	];
}

/**
 * The volume path.
 *
 * The current pipeline decodes and re-encodes every frame of every stream
 * regardless of volume, so there is only one number to report here — the same
 * one whether the listener asked for a volume change or not.
 */
export async function benchVolume(frames: Buffer[]): Promise<Measurement[]> {
	const engine = createOpusEngine();
	let cursor = 0;

	const scaled = await perFrame(10, 2_000, () => {
		const frame = frames[cursor++ % frames.length];
		const pcm = engine.decode(frame);
		// The gain the bot applies, in the same place it applies it.
		for (let i = 0; i + 1 < pcm.length; i += 2) {
			pcm.writeInt16LE(Math.round(pcm.readInt16LE(i) * 0.5), i);
		}
		engine.encode(pcm.subarray(0, FRAME_BYTES));
	});

	engine.destroy();

	return [
		{
			name: "volume_scaled",
			...scaled,
			notes: `${SAMPLE_RATE}Hz ${CHANNELS}ch, @discordjs/opus`,
		},
		{
			name: "volume_passthrough",
			...scaled,
			notes: "no passthrough path exists: every frame is decoded and re-encoded",
		},
	];
}
