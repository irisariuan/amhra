import { Transform, type TransformCallback } from "node:stream";

/**
 * Minimal Matroska/WebM demuxer that emits the Opus packets of the first
 * A_OPUS track.
 *
 * yt-dlp's `bestaudio` for YouTube is WebM carrying Opus in 20ms packets, which
 * is already the exact framing Discord wants, so the only reason to touch the
 * audio at all is gain. Pulling the packets out here means the playback path
 * never has to spawn ffmpeg just to hand back PCM.
 *
 * Only the subset of EBML needed to reach the blocks is parsed; every other
 * element is skipped by its declared size.
 */

/** Element IDs, kept with their VINT marker bit intact */
const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_CODEC_ID = 0x86;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMESTAMP = 0xe7;
const ID_BLOCK_GROUP = 0xa0;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK = 0xa1;

/** Descended into rather than skipped: their children are what we are after */
const MASTERS = new Set([
	ID_SEGMENT,
	ID_TRACKS,
	ID_TRACK_ENTRY,
	ID_CLUSTER,
	ID_BLOCK_GROUP,
]);

/** Read whole before being handed to handleLeaf() */
const LEAVES = new Set([
	ID_TRACK_NUMBER,
	ID_CODEC_ID,
	ID_TIMESTAMP,
	ID_SIMPLE_BLOCK,
	ID_BLOCK,
]);

/**
 * Total byte width of a VINT from its first byte. The width is one more than
 * the number of leading zero bits.
 */
function vintLength(first: number) {
	if (first >= 0x80) return 1;
	if (first >= 0x40) return 2;
	if (first >= 0x20) return 3;
	if (first >= 0x10) return 4;
	if (first >= 0x08) return 5;
	if (first >= 0x04) return 6;
	if (first >= 0x02) return 7;
	if (first >= 0x01) return 8;
	return 0;
}

interface Vint {
	value: number;
	length: number;
	/** Every value bit set: a master element of undeclared length */
	unknown: boolean;
}

/** Element ID: the marker bit is part of the value, so the bytes are read as-is */
function readId(buf: Buffer, offset: number) {
	if (offset >= buf.length) return null;
	const length = vintLength(buf[offset]);
	// IDs are at most 4 bytes; anything wider means we are not element-aligned
	if (length === 0 || length > 4) return null;
	if (offset + length > buf.length) return null;
	return { value: buf.readUIntBE(offset, length), length };
}

/** Size VINT: the marker bit is stripped, the rest is a big-endian integer */
function readSize(buf: Buffer, offset: number): Vint | null {
	if (offset >= buf.length) return null;
	const first = buf[offset];
	const length = vintLength(first);
	if (length === 0) return null;
	if (offset + length > buf.length) return null;
	const mask = 0xff >> length;
	let value = first & mask;
	let unknown = value === mask;
	for (let i = 1; i < length; i++) {
		const byte = buf[offset + i];
		value = value * 256 + byte;
		if (byte !== 0xff) unknown = false;
	}
	return { value, length, unknown };
}

/** Unsigned EBML integer of any width, as stored in TrackNumber/Timestamp */
function readUint(data: Buffer) {
	let value = 0;
	for (const byte of data) value = value * 256 + byte;
	return value;
}

interface OpenMaster {
	id: number;
	/** Absolute offset one past this element's last data byte */
	end: number;
}

export class WebmOpusDemuxer extends Transform {
	private buf: Buffer = Buffer.alloc(0);
	/** Absolute stream offset of buf[0] */
	private absolute = 0;
	/** Bytes of an unwanted element still to be discarded */
	private skipping = 0;
	private stack: OpenMaster[] = [];
	private checkedHeader = false;

	/** Track number of the A_OPUS track, once Tracks has been parsed */
	private opusTrack: number | null = null;
	private entryTrackNumber: number | null = null;
	private entryCodec: string | null = null;

	/** Timestamp of the cluster currently being read, in Matroska ticks */
	clusterTimestamp = 0;
	/** Opus packets emitted so far */
	packetCount = 0;

	constructor() {
		super({ readableObjectMode: true, writableObjectMode: false });
	}

	_transform(chunk: Buffer, _encoding: BufferEncoding, cb: TransformCallback) {
		this.buf = this.buf.length
			? Buffer.concat([this.buf, chunk])
			: (chunk as Buffer);
		try {
			this.parse();
		} catch (error) {
			return cb(error as Error);
		}
		cb();
	}

	_flush(cb: TransformCallback) {
		// A truncated tail is expected: cache files can be cut short mid-download
		cb();
	}

	private parse() {
		let cursor = 0;
		// A non-Matroska source would otherwise be parsed as garbage and simply
		// yield no packets, which is indistinguishable from a track-less file.
		// Failing loudly lets the caller fall back to ffmpeg.
		if (!this.checkedHeader) {
			const id = readId(this.buf, 0);
			if (!id) {
				if (this.buf.length >= 4) {
					throw new Error("Not a WebM stream: no EBML header");
				}
				return; // too short to tell yet
			}
			if (id.value !== ID_EBML) {
				throw new Error(
					`Not a WebM stream: leading element 0x${id.value.toString(16)}`,
				);
			}
			this.checkedHeader = true;
		}
		for (;;) {
			if (this.skipping > 0) {
				const take = Math.min(this.skipping, this.buf.length - cursor);
				cursor += take;
				this.skipping -= take;
				// Ran out of data before the element ended
				if (this.skipping > 0) break;
			}

			const absolute = this.absolute + cursor;
			while (
				this.stack.length &&
				this.stack[this.stack.length - 1].end <= absolute
			) {
				this.closeMaster(this.stack.pop() as OpenMaster);
			}

			const id = readId(this.buf, cursor);
			if (!id) break;
			const size = readSize(this.buf, cursor + id.length);
			if (!size) break;

			const headerLength = id.length + size.length;
			const dataStart = absolute + headerLength;

			if (MASTERS.has(id.value)) {
				this.stack.push({
					id: id.value,
					end: size.unknown
						? Number.POSITIVE_INFINITY
						: dataStart + size.value,
				});
				if (id.value === ID_TRACK_ENTRY) {
					this.entryTrackNumber = null;
					this.entryCodec = null;
				}
				cursor += headerLength;
				continue;
			}

			if (LEAVES.has(id.value)) {
				const end = cursor + headerLength + size.value;
				// Leaves are handled whole, so wait for the rest of it
				if (end > this.buf.length) break;
				this.handleLeaf(
					id.value,
					this.buf.subarray(cursor + headerLength, end),
				);
				cursor = end;
				continue;
			}

			// Unwanted: drop its payload, possibly across several chunks
			cursor += headerLength;
			this.skipping = size.unknown ? 0 : size.value;
		}

		this.absolute += cursor;
		this.buf = this.buf.subarray(cursor);
	}

	private closeMaster(master: OpenMaster) {
		if (master.id !== ID_TRACK_ENTRY) return;
		if (this.opusTrack !== null) return;
		if (this.entryTrackNumber === null) return;
		// CodecID is a zero-padded ASCII string
		if (!this.entryCodec?.replace(/\0+$/, "").startsWith("A_OPUS")) return;
		this.opusTrack = this.entryTrackNumber;
	}

	private handleLeaf(id: number, data: Buffer) {
		switch (id) {
			case ID_TRACK_NUMBER:
				this.entryTrackNumber = readUint(data);
				return;
			case ID_CODEC_ID:
				this.entryCodec = data.toString("ascii");
				return;
			case ID_TIMESTAMP:
				// Only clusters carry a timestamp we care about
				if (this.stack[this.stack.length - 1]?.id === ID_CLUSTER) {
					this.clusterTimestamp = readUint(data);
				}
				return;
			case ID_SIMPLE_BLOCK:
			case ID_BLOCK:
				this.emitBlock(data);
				return;
		}
	}

	private emitBlock(data: Buffer) {
		if (this.opusTrack === null) return;
		const track = readSize(data, 0);
		if (!track || track.value !== this.opusTrack) return;

		// track VINT, then int16 timecode, then a flags byte
		const flagsOffset = track.length + 2;
		if (flagsOffset >= data.length) return;
		const lacing = (data[flagsOffset] >> 1) & 0x03;
		let cursor = flagsOffset + 1;

		if (lacing === 0) {
			this.pushPacket(data.subarray(cursor));
			return;
		}

		if (cursor >= data.length) return;
		const frames = data[cursor] + 1;
		cursor++;

		const sizes: number[] = [];
		if (lacing === 2) {
			// Fixed: every frame is the same width
			const total = data.length - cursor;
			if (total % frames !== 0) return;
			sizes.push(...Array<number>(frames).fill(total / frames));
		} else if (lacing === 1) {
			// Xiph: 255-terminated byte runs, one run per frame but the last
			for (let i = 0; i < frames - 1; i++) {
				let size = 0;
				for (;;) {
					if (cursor >= data.length) return;
					const byte = data[cursor++];
					size += byte;
					if (byte !== 0xff) break;
				}
				sizes.push(size);
			}
		} else {
			// EBML: an unsigned VINT, then signed VINT deltas against it
			const first = readSize(data, cursor);
			if (!first) return;
			cursor += first.length;
			sizes.push(first.value);
			for (let i = 1; i < frames - 1; i++) {
				const delta = readSize(data, cursor);
				if (!delta) return;
				cursor += delta.length;
				// Signed VINTs are biased by half their value range
				const bias = 2 ** (7 * delta.length - 1) - 1;
				sizes.push(sizes[sizes.length - 1] + delta.value - bias);
			}
		}

		// Every lacing but fixed leaves the final frame's size implicit
		if (lacing !== 2) {
			const used = sizes.reduce((a, b) => a + b, 0);
			sizes.push(data.length - cursor - used);
		}

		for (const size of sizes) {
			if (size < 0 || cursor + size > data.length) return;
			this.pushPacket(data.subarray(cursor, cursor + size));
			cursor += size;
		}
	}

	private pushPacket(packet: Buffer) {
		if (!packet.length) return;
		this.packetCount++;
		this.push(packet);
	}
}
