import { Readable } from "node:stream";
import { createOpusEngine, FRAME_BYTES, OpusEngine } from "./opus";

export interface VolumeControl {
	setVolume(volume: number): void;
	readonly volume: number;
}

export interface VolumeOpusStreamOptions {
	/** Initial linear gain, 1 = untouched */
	volume?: number;
	/**
	 * How many encoded packets may sit in this stream's read buffer.
	 * Each packet is 20ms, and gain is applied at encode time, so this is the
	 * upper bound of the delay between setVolume() and the user hearing it.
	 */
	bufferedFrames?: number;
	/** Called once the stream is done with the PCM source */
	onClose?: () => void;
}

/**
 * Reads signed 16-bit little-endian PCM (48kHz stereo), applies the current
 * gain and encodes Opus packets on demand.
 *
 * Gain is applied at the very last step before encoding and the read buffer is
 * kept at a couple of frames, so a volume change lands within ~20-40ms instead
 * of after the several hundred milliseconds of PCM that a
 * transform-in-the-middle pipeline keeps buffered downstream.
 */
export class VolumeOpusStream extends Readable implements VolumeControl {
	private source: Readable;
	private engine: OpusEngine;
	private gain: number;
	private waiting = false;
	private ended = false;
	private onClose?: () => void;

	constructor(source: Readable, options: VolumeOpusStreamOptions = {}) {
		super({
			objectMode: true,
			highWaterMark: options.bufferedFrames ?? 2,
		});
		this.source = source;
		this.engine = createOpusEngine();
		this.gain = 1;
		this.onClose = options.onClose;
		if (options.volume !== undefined) this.setVolume(options.volume);

		this.source.on("error", (error) => this.destroy(error));
		this.source.on("end", () => {
			this.ended = true;
		});
	}

	get volume() {
		return this.gain;
	}

	setVolume(volume: number) {
		if (!Number.isFinite(volume) || volume < 0) return;
		this.gain = volume;
	}

	private applyGain(frame: Buffer) {
		const gain = this.gain;
		if (gain === 1) return frame;
		if (gain === 0) return Buffer.alloc(frame.length);
		for (let i = 0; i + 1 < frame.length; i += 2) {
			const sample = Math.round(frame.readInt16LE(i) * gain);
			frame.writeInt16LE(
				sample > 32767 ? 32767 : sample < -32768 ? -32768 : sample,
				i,
			);
		}
		return frame;
	}

	private encodeFrame(pcm: Buffer) {
		// Buffer.from copies: the gain is applied in place and the source chunk
		// may be shared with the caller's cache
		const frame =
			pcm.length === FRAME_BYTES
				? Buffer.from(pcm)
				: Buffer.concat([pcm], FRAME_BYTES);
		return this.engine.encode(this.applyGain(frame));
	}

	_read() {
		if (this.destroyed) return;
		const frame = this.source.read(FRAME_BYTES) as Buffer | null;
		if (frame) {
			this.push(this.encodeFrame(frame));
			return;
		}
		if (this.ended) {
			// Zero pad whatever is left of the last frame
			const rest = this.source.read() as Buffer | null;
			if (rest?.length) this.push(this.encodeFrame(rest));
			this.push(null);
			return;
		}
		if (this.waiting) return;
		this.waiting = true;
		const retry = () => {
			if (!this.waiting) return;
			this.waiting = false;
			this.source.off("readable", retry);
			this.source.off("end", retry);
			this._read();
		};
		this.source.once("readable", retry);
		this.source.once("end", retry);
	}

	_destroy(error: Error | null, callback: (error: Error | null) => void) {
		this.source.destroy();
		this.engine.destroy();
		this.onClose?.();
		callback(error);
	}
}
