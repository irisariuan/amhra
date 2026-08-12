import type { Readable } from "node:stream";
import { Readable as ReadableStream } from "node:stream";
import { globalApp } from "../misc";
import { createOpusEngine, type OpusEngine, type VolumeControl } from "./volume";
import { WebmOpusDemuxer } from "./webm";

/** Every Opus packet YouTube muxes is one 20ms frame */
export const PACKET_MS = 20;

/**
 * Packets decoded and thrown away before the first audible one after a jump.
 * Opus carries state between frames, so decoding cold produces a short ring.
 */
const PREROLL_PACKETS = 4;

/** Packets kept behind the anchor before falling back to re-reading the file */
const DEFAULT_PLAYED_WINDOW = 1500; // 30s

/**
 * Packets kept ahead of the anchor. The download outruns playback by a long
 * way, so without a cap a long mix or a livestream would be pulled into memory
 * in its entirety. Past this point incoming packets are dropped and the cache
 * file serves as the backing store instead.
 */
const DEFAULT_AHEAD_WINDOW = 90_000; // 30min, ~54MB of Opus

/** Leading evicted slots tolerated before the array is compacted */
const COMPACT_THRESHOLD = 512;

export interface OpusStreamOptions {
	/** Initial linear gain, 1 = untouched */
	volume?: number;
	/** How many already-played packets stay in memory */
	playedWindow?: number;
	/** How many not-yet-played packets stay in memory */
	aheadWindow?: number;
	/**
	 * Opens a fresh WebM byte stream of the same track, used when a seek lands
	 * behind the window. Resolved lazily because the cache file is renamed from
	 * `.temp.music` to `.music` the moment the download finishes.
	 */
	openCache?: () => Readable | null;
	/** Called once the stream is done with its source */
	onClose?: () => void;
}

/**
 * Serves Opus packets at a movable anchor.
 *
 * Packets arrive from a WebM demuxer and are held in a window: everything ahead
 * of the anchor is kept (the download outruns playback, so this fills up early
 * and then stops growing), while packets more than `playedWindow` behind it are
 * dropped. A seek inside the window is an index assignment; a seek behind it
 * re-demuxes the cache file.
 *
 * Gain is applied between decode and encode, so a volume change lands within
 * the read buffer's couple of frames rather than behind a pipe full of
 * already-scaled audio. At `gain === 1` the packet is forwarded untouched and
 * no codec work happens at all.
 */
export class OpusStream extends ReadableStream implements VolumeControl {
	private source: Readable;
	private engine: OpusEngine | null = null;
	private gain = 1;

	/** packets[0] is stream index `base`; evicted slots are nulled, not removed */
	private packets: (Buffer | null)[] = [];
	private base = 0;
	/** Leading slots in `packets` already evicted */
	private evicted = 0;
	/** Index of the next packet to emit */
	private anchor = 0;

	/** Byte stream feeding `source`, only set for refills we opened ourselves */
	private bytes?: Readable;
	/** Bumped on every source swap so stale sources can be ignored */
	private generation = 0;

	private sourceEnded = false;
	private waiting = false;
	private refilling = false;
	/** Packets still to be decoded and discarded to warm the decoder */
	private preroll = 0;

	/** Set once the ahead cap forced packets to be discarded */
	private droppedAhead = false;

	private playedWindow: number;
	private aheadWindow: number;
	private openCache?: () => Readable | null;
	private onClose?: () => void;

	constructor(source: Readable, options: OpusStreamOptions = {}) {
		super({ objectMode: true, highWaterMark: 2 });
		this.playedWindow = options.playedWindow ?? DEFAULT_PLAYED_WINDOW;
		this.aheadWindow = options.aheadWindow ?? DEFAULT_AHEAD_WINDOW;
		this.openCache = options.openCache;
		this.onClose = options.onClose;
		if (options.volume !== undefined) this.setVolume(options.volume);
		this.source = source;
		this.attach(source, this.generation);
	}

	// ---- volume ----------------------------------------------------------

	get volume() {
		return this.gain;
	}

	setVolume(volume: number) {
		if (!Number.isFinite(volume) || volume < 0) return;
		this.gain = volume;
	}

	// ---- position --------------------------------------------------------

	/** Playback position in milliseconds. Authoritative, unlike the wall clock. */
	get positionMs() {
		return this.anchor * PACKET_MS;
	}

	/** Milliseconds of audio demuxed so far */
	get bufferedMs() {
		return (this.base + this.packets.length) * PACKET_MS;
	}

	/**
	 * Move the anchor. Cheap inside the buffered window; behind it, the cache
	 * file is re-demuxed, which costs a file read rather than a re-download.
	 */
	relocate(ms: number) {
		const target = Math.max(0, Math.round(ms / PACKET_MS));
		if (target === this.anchor) return;
		this.anchor = target;
		// Only the decode path carries state worth warming
		this.preroll = this.gain === 1 ? 0 : PREROLL_PACKETS;
		this.trim();
		// A pending wait was for the old anchor and no longer means anything
		this.waiting = false;
		this.dropQueued();
	}

	/**
	 * Throw away packets already encoded and sitting in the read buffer.
	 *
	 * They belong to the old anchor, so without this a seek plays a couple of
	 * frames from the previous position first. Only ever a few packets, but it
	 * is the difference between a seek being exact and being approximately
	 * right, so it is worth reaching for the buffer directly. Guarded, since
	 * this is not public stream API.
	 */
	private dropQueued() {
		const state = (
			this as unknown as {
				_readableState?: {
					// A BufferList before Node 24, a plain Array from Node 24 on
					buffer?: { clear?: () => void; length: number };
					// Node 24 reads through a cursor instead of shifting
					bufferIndex?: number;
					length: number;
				};
			}
		)._readableState;
		const buffer = state?.buffer;
		if (!state || !buffer) return;
		if (typeof buffer.clear === "function") buffer.clear();
		else if (Array.isArray(buffer)) buffer.length = 0;
		else return;
		state.length = 0;
		// Leaving the cursor behind would make the next pushed packet read back
		// as undefined, since it lands at index 0 while the cursor points past it
		if (typeof state.bufferIndex === "number") state.bufferIndex = 0;
		// Emptying the queue by hand skips the machinery that would normally
		// ask for more, so the stream has to be nudged back into flowing
		process.nextTick(() => {
			if (!this.destroyed) this.read(0);
		});
	}

	// ---- window ----------------------------------------------------------

	private get appended() {
		return this.base + this.packets.length;
	}

	private at(index: number) {
		if (index < this.base + this.evicted) return "evicted" as const;
		if (index >= this.appended) {
			// Dropped by the ahead cap rather than simply not demuxed yet
			return this.droppedAhead ? ("evicted" as const) : ("pending" as const);
		}
		return this.packets[index - this.base] as Buffer;
	}

	/** Returns false once the ahead cap is reached and the packet was dropped */
	private append(packet: Buffer) {
		if (this.appended - this.anchor >= this.aheadWindow) {
			this.droppedAhead = true;
			return false;
		}
		this.packets.push(packet);
		return true;
	}

	/** Drop packets that have fallen out of the window behind the anchor */
	private trim() {
		const keepFrom = this.anchor - this.playedWindow;
		while (
			this.base + this.evicted < keepFrom &&
			this.evicted < this.packets.length
		) {
			this.packets[this.evicted] = null;
			this.evicted++;
		}
		if (this.evicted >= COMPACT_THRESHOLD) {
			this.packets.splice(0, this.evicted);
			this.base += this.evicted;
			this.evicted = 0;
		}
	}

	// ---- source ----------------------------------------------------------

	/**
	 * Wire up a packet source. Every refill bumps the generation so that a
	 * replaced source still draining its buffers cannot append into the window
	 * it no longer owns.
	 */
	private attach(source: Readable, generation: number) {
		source.on("data", (packet: Buffer) => {
			if (generation !== this.generation) return;
			this.append(packet);
			if (this.waiting) {
				this.waiting = false;
				this._read();
			}
		});
		source.on("end", () => {
			if (generation !== this.generation) return;
			this.sourceEnded = true;
			if (this.waiting) {
				this.waiting = false;
				this._read();
			}
		});
		source.on("error", (error) => {
			if (generation !== this.generation) return;
			this.destroy(error);
		});
	}

	/** Tear down the current source and the byte stream feeding it */
	private detachSource() {
		this.generation++;
		this.source.destroy();
		this.bytes?.destroy();
		this.bytes = undefined;
	}

	/**
	 * Rebuild the window from the cache file, starting a little before the
	 * anchor so the decoder has something to warm up on.
	 */
	private refill() {
		const bytes = this.openCache?.();
		if (!bytes) {
			globalApp.warn(
				"OpusStream seeked outside the buffer with no cache file to fall back on",
			);
			this.push(null);
			return;
		}

		const keepFrom = Math.max(0, this.anchor - PREROLL_PACKETS);
		this.refilling = true;
		this.packets = [];
		this.base = keepFrom;
		this.evicted = 0;
		this.sourceEnded = false;
		this.droppedAhead = false;

		this.detachSource();
		const generation = this.generation;
		const demuxer = new WebmOpusDemuxer();
		let index = 0;
		demuxer.on("data", (packet: Buffer) => {
			if (generation !== this.generation) return;
			// Skip forward to the region we actually want to hold
			if (index++ < keepFrom) return;
			this.append(packet);
			if (this.refilling && this.appended > this.anchor) {
				this.refilling = false;
				this._read();
			}
			if (this.waiting) {
				this.waiting = false;
				this._read();
			}
		});
		demuxer.on("end", () => {
			if (generation !== this.generation) return;
			this.sourceEnded = true;
			if (this.refilling) {
				this.refilling = false;
				this._read();
			}
			if (this.waiting) {
				this.waiting = false;
				this._read();
			}
		});
		demuxer.on("error", (error) => {
			if (generation !== this.generation) return;
			this.destroy(error);
		});

		this.source = demuxer;
		this.bytes = bytes;
		bytes.pipe(demuxer);
	}

	// ---- codec -----------------------------------------------------------

	private render(packet: Buffer) {
		if (this.gain === 1) return packet;
		if (!this.engine) this.engine = createOpusEngine();
		const pcm = this.engine.decode(packet);
		const gain = this.gain;
		if (gain === 0) return this.engine.encode(Buffer.alloc(pcm.length));
		for (let i = 0; i + 1 < pcm.length; i += 2) {
			const sample = Math.round(pcm.readInt16LE(i) * gain);
			pcm.writeInt16LE(
				sample > 32767 ? 32767 : sample < -32768 ? -32768 : sample,
				i,
			);
		}
		return this.engine.encode(pcm);
	}

	/** Decode the packets just before the anchor purely to prime decoder state */
	private warm() {
		if (!this.preroll) return;
		if (!this.engine) this.engine = createOpusEngine();
		const from = Math.max(0, this.anchor - this.preroll);
		for (let i = from; i < this.anchor; i++) {
			const packet = this.at(i);
			if (typeof packet === "string") break;
			try {
				this.engine.decode(packet);
			} catch {
				// A cold decoder rejecting a frame is exactly what we are fixing
			}
		}
		this.preroll = 0;
	}

	// ---- stream ----------------------------------------------------------

	_read() {
		if (this.destroyed || this.refilling) return;

		const packet = this.at(this.anchor);

		if (packet === "evicted") return this.refill();

		if (packet === "pending") {
			if (this.sourceEnded) return void this.push(null);
			this.waiting = true;
			return;
		}

		this.warm();
		this.anchor++;
		this.trim();
		this.push(this.render(packet));
	}

	_destroy(error: Error | null, callback: (error: Error | null) => void) {
		this.generation++;
		this.source.destroy();
		this.bytes?.destroy();
		this.engine?.destroy();
		this.packets = [];
		this.onClose?.();
		callback(error);
	}
}
