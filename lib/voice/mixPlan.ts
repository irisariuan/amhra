/**
 * What one guild has mixed in over its queue, as this process knows it.
 *
 * The sidecar owns the audio; this only remembers what was asked of it, so
 * `/mix list` can answer and a user can name a layer by its place in that
 * list. Kept free of imports for the same reason as `nativePlan.ts`: the rules
 * here are testable without loading the player.
 *
 * Layer ids are never reused. Removing a layer fades it out, and its
 * `layerFinished` lands a frame later; had its id been handed to a new layer in
 * between, that late report would delete the new one.
 */

/** Kept in step with MAX_LAYERS in rust/amhra-voice/src/mixer.rs. */
export const MAX_LAYERS = 8;

export interface MixLayer {
	/** The sidecar's name for it. Internal: users go by list position. */
	id: string;
	trackId: string;
	title: string;
	url: string;
	/** Percent, as the user typed it. */
	volume: number;
}

export class GuildMix {
	/** The queue track's own level, in percent. */
	mainVolume = 100;
	private layers: MixLayer[] = [];
	private nextId = 1;

	list(): readonly MixLayer[] {
		return this.layers;
	}

	get size() {
		return this.layers.length;
	}

	isFull() {
		return this.layers.length >= MAX_LAYERS;
	}

	/** Register a layer and give it a fresh id. Null when the mix is full. */
	add(layer: Omit<MixLayer, "id">): MixLayer | null {
		if (this.isFull()) return null;
		const added = { ...layer, id: String(this.nextId++) };
		this.layers.push(added);
		return added;
	}

	/** The layer at a 1-based position in `list()`. */
	at(position: number): MixLayer | undefined {
		if (!Number.isInteger(position) || position < 1) return undefined;
		return this.layers[position - 1];
	}

	/**
	 * Forget a layer, whether it was removed here or ended on its own. Returns
	 * whether it was still listed, so a late report is a no-op.
	 */
	forget(id: string): boolean {
		const before = this.layers.length;
		this.layers = this.layers.filter((layer) => layer.id !== id);
		return this.layers.length !== before;
	}

	/**
	 * Record a layer trading places with the queue's track: the layer now
	 * holds `main`, and the two volumes swap too, because each song kept its
	 * own level through the exchange. Returns what the layer held before, or
	 * null if it is not listed.
	 */
	swap(id: string, main: Omit<MixLayer, "id" | "volume">): MixLayer | null {
		const layer = this.layers.find((layer) => layer.id === id);
		if (!layer) return null;
		const before = { ...layer };
		Object.assign(layer, main, { volume: this.mainVolume });
		this.mainVolume = before.volume;
		return before;
	}

	setVolume(id: string, volume: number): boolean {
		const layer = this.layers.find((layer) => layer.id === id);
		if (!layer) return false;
		layer.volume = volume;
		return true;
	}
}

/** A user's percent as the sidecar's linear gain. */
export function gainFromPercent(volume: number) {
	return Math.max(0, volume) / 100;
}
