import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { globalApp } from "../misc";

let engineName: string | null = null;

export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
/** Samples per channel in one Opus frame (20ms at 48kHz) */
export const FRAME_SIZE = 960;
/** Bytes of signed 16-bit little-endian PCM in one Opus frame */
export const FRAME_BYTES = FRAME_SIZE * CHANNELS * 2;

export interface NativeOpus {
	OpusEncoder: new (
		rate: number,
		channels: number,
	) => { encode(pcm: Buffer): Buffer; decode(packet: Buffer): Buffer };
}
export interface OpusEngine {
	encode(pcm: Buffer): Buffer;
	decode(packet: Buffer): Buffer;
	destroy(): void;
}

/**
 * Load the native Opus binding, going around node-pre-gyp when it gives up too
 * early.
 *
 * node-pre-gyp builds the prebuild folder name from `process.versions.modules`,
 * so a package shipping `node-v127-napi-v3-...` is considered missing on Node
 * 24 (module version 137). The NAPI ABI is stable across Node releases though,
 * and that binary loads and runs fine, so any napi prebuild is tried directly
 * before falling back to the pure-JS encoder.
 */
export function loadNativeOpus(): NativeOpus | null {
	try {
		return require("@discordjs/opus") as NativeOpus;
	} catch {
		// Fall through to the prebuild scan below
	}
	try {
		const root = dirname(dirname(require.resolve("@discordjs/opus")));
		const prebuilds = join(root, "prebuild");
		for (const entry of readdirSync(prebuilds)) {
			if (!entry.includes("napi")) continue;
			const binding = join(prebuilds, entry, "opus.node");
			if (!existsSync(binding)) continue;
			const loaded = require(binding) as NativeOpus;
			if (engineName !== "@discordjs/opus") {
				globalApp.warn(
					`node-pre-gyp missed the Opus prebuild, loaded ${entry} directly`,
				);
			}
			return loaded;
		}
	} catch {
		// No usable prebuild
	}
	return null;
}

/**
 * Pick whatever Opus binding is installed. Native first, pure JS as fallback.
 *
 * Encoder and decoder are separate instances: the two directions each carry
 * their own state, and sharing one object between them is not something either
 * binding promises to support.
 */
export function createOpusEngine(): OpusEngine {
	const native = loadNativeOpus();
	if (native) {
		const encoder = new native.OpusEncoder(SAMPLE_RATE, CHANNELS);
		const decoder = new native.OpusEncoder(SAMPLE_RATE, CHANNELS);
		if (engineName !== "@discordjs/opus") {
			engineName = "@discordjs/opus";
			globalApp.important("Opus engine: @discordjs/opus");
		}
		return {
			encode: (pcm: Buffer) => encoder.encode(pcm),
			decode: (packet: Buffer) => decoder.decode(packet),
			destroy: () => {},
		};
	}
	if (engineName !== "opusscript") {
		globalApp.warn(
			"@discordjs/opus unavailable, falling back to opusscript",
		);
	}
	const OpusScript = require("opusscript");
	const encoder = new OpusScript(
		SAMPLE_RATE,
		CHANNELS,
		OpusScript.Application.AUDIO,
	);
	const decoder = new OpusScript(
		SAMPLE_RATE,
		CHANNELS,
		OpusScript.Application.AUDIO,
	);
	if (engineName !== "opusscript") {
		engineName = "opusscript";
		globalApp.important("Opus engine: opusscript");
	}
	return {
		encode: (pcm: Buffer) => encoder.encode(pcm, FRAME_SIZE),
		// opusscript hands back a Uint8Array view, not a Buffer
		decode: (packet: Buffer) => Buffer.from(decoder.decode(packet)),
		destroy: () => {
			encoder.delete?.();
			decoder.delete?.();
		},
	};
}
