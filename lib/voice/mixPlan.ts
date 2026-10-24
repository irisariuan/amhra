/**
 * What one guild has mixed in over its queue, as this process knows it.
 *
 * The mix is a set of *tracks*, like the lanes of a track editor. Each plays
 * at its own volume, one song at a time, and has a queue of its own: when its
 * song ends, the next one starts after the track's gap. They run beside the
 * guild's main queue, not under it — the main queue can run dry, skip or be
 * swapped while every track carries on.
 *
 * The sidecar owns the audio and knows only *layers*: one per track that is
 * playing a song. This is the bookkeeping that turns those layers into tracks,
 * and it is kept free of imports for the same reason as `nativePlan.ts`: the
 * rules are testable without loading the player. Nothing here sets a timer.
 * A waiting track records when it started waiting and why; when its next
 * song is due follows from that song's gap, and the caller polls `due()`.
 * That keeps pausing, reordering and changing a gap a matter of arithmetic.
 *
 * Ids are never reused, for layers or for tracks. Removing a layer fades it
 * out, and its `layerFinished` lands a frame later; had its id been handed to
 * a new layer in between, that late report would end the new one.
 */

/**
 * Tracks one guild may have. Each plays at most one layer, so this is kept in
 * step with MAX_LAYERS in rust/amhra-voice/src/mixer.rs.
 */
export const MAX_TRACKS = 8;
/** Songs one track may have waiting, so a stuck bot cannot pile up thousands. */
export const MAX_TRACK_QUEUE = 100;
/** The longest silence a track may leave between two songs. */
export const MAX_GAP_MS = 10 * 60_000;
/**
 * The longest silence before one song, set by where it was dropped on the
 * editor's timeline. Far more than a track's gap: lining a song up after a
 * long queue on another lane can put it an hour or more out.
 */
export const MAX_LEAD_IN_MS = 6 * 60 * 60_000;

export interface MixSong {
	videoId: string;
	title: string;
	url: string;
	/** Null when the video's length was not known when it was queued. */
	durationMs: number | null;
	/**
	 * Where to start it from, for a song taken off the queue part-way
	 * through. A looping track plays it from the top the next time round.
	 */
	startMs?: number;
	/**
	 * Silence before it, in place of the track's gap: set by where it was
	 * put on the editor's timeline, to line it up with another lane.
	 */
	gapBeforeMs?: number;
}

export interface PlayingSong extends MixSong {
	/** The sidecar's name for the layer playing it. */
	layerId: string;
	/**
	 * When its position zero was, or would have been, in epoch milliseconds.
	 * Moved forward by however long the guild spends paused.
	 */
	startedAt: number;
	/** Where in the song it was started from, for a correction on `layerStarted`. */
	startMs: number;
}

export interface MixTrack {
	/** Internal and stable: users go by list position, the dashboard by id. */
	id: string;
	/** Percent, as the user typed it. */
	volume: number;
	/** Silence between one song ending and the next starting. */
	gapMs: number;
	/** Whether a song that ends goes to the back of the track's queue. */
	loop: boolean;
	playing: PlayingSong | null;
	/** Fetched and about to play: off the queue, not yet a layer. */
	loading: MixSong | null;
	/** Up next, in order. */
	queue: MixSong[];
	/** Since when, and after what, the track has been waiting for its next song. */
	wait: Wait | null;
}

/**
 * A wait for a track's next song, counted from `from`: after a song ended
 * it is the song's gap, or the track's; on a silent track it is the song's
 * own gap or none; after a skip or a failed fetch it is none at all.
 */
export interface Wait {
	from: number;
	after: "song" | "silence" | "skip";
}

export interface TrackOptions {
	volume?: number;
	gapMs?: number;
	loop?: boolean;
}

export class GuildMix {
	/** The queue track's own level, in percent. */
	mainVolume = 100;
	private tracks: MixTrack[] = [];
	private nextTrackId = 1;
	private nextLayerId = 1;
	/** When the guild was paused, while it is. */
	private heldAt: number | null = null;

	list(): readonly MixTrack[] {
		return this.tracks;
	}

	get size() {
		return this.tracks.length;
	}

	isFull() {
		return this.tracks.length >= MAX_TRACKS;
	}

	get held() {
		return this.heldAt !== null;
	}

	/** The track at a 1-based position in `list()`. */
	at(position: number): MixTrack | undefined {
		if (!Number.isInteger(position) || position < 1) return undefined;
		return this.tracks[position - 1];
	}

	find(id: string): MixTrack | undefined {
		return this.tracks.find((track) => track.id === id);
	}

	/** 1-based, as `/mix list` numbers it. Zero when it is not listed. */
	positionOf(track: MixTrack) {
		return this.tracks.indexOf(track) + 1;
	}

	/** Whether anything in the mix is playing, or will without being asked. */
	busy() {
		return this.tracks.some(
			(track) => track.playing || track.loading || this.dueAt(track) !== null,
		);
	}

	/** A new, empty track. Null when the mix already has as many as it may. */
	addTrack(options: TrackOptions = {}): MixTrack | null {
		if (this.isFull()) return null;
		const track: MixTrack = {
			id: String(this.nextTrackId++),
			volume: options.volume ?? 100,
			gapMs: clampGap(options.gapMs ?? 0),
			loop: options.loop ?? false,
			playing: null,
			loading: null,
			queue: [],
			wait: null,
		};
		this.tracks.push(track);
		return track;
	}

	/**
	 * Drop a track and everything queued on it. Returns the layer it was
	 * playing, for the caller to stop, or null when it was silent.
	 */
	removeTrack(track: MixTrack): string | null {
		this.tracks = this.tracks.filter((listed) => listed !== track);
		const layerId = track.playing?.layerId ?? null;
		// Cleared so a fetch still running for it finds it gone.
		track.playing = null;
		track.loading = null;
		track.wait = null;
		return layerId;
	}

	/** Drop every track. Returns the layers that were playing. */
	clear(): string[] {
		return [...this.tracks].flatMap((track) => this.removeTrack(track) ?? []);
	}

	/**
	 * Queue a song on a track, at `index` in its queue or at the end. A silent
	 * track starts it after its own gap, or straight away: the track's gap is
	 * only between songs. False when the track's queue is full.
	 */
	enqueue(track: MixTrack, song: MixSong, now: number, index?: number): boolean {
		if (track.queue.length >= MAX_TRACK_QUEUE) return false;
		const at = index === undefined ? track.queue.length : clampIndex(index, track.queue.length);
		track.queue.splice(at, 0, song);
		this.placed(track, at, now);
		return true;
	}

	/** Take the song at `index` off a track's queue. */
	removeSong(track: MixTrack, index: number): MixSong | null {
		if (!Number.isInteger(index) || index < 0 || index >= track.queue.length) return null;
		const [removed] = track.queue.splice(index, 1);
		if (!track.queue.length) track.wait = null;
		return removed ?? null;
	}

	/**
	 * Move a queued song within a track or onto another. `toIndex` is where it
	 * lands in the target's queue as it is after the song left. `gapBeforeMs`,
	 * when given, is the silence it now waits for after whatever comes before
	 * it. False when there is no song at `fromIndex`, or the target is full.
	 */
	moveSong(
		from: MixTrack,
		fromIndex: number,
		to: MixTrack,
		toIndex: number,
		now: number,
		gapBeforeMs?: number,
	): boolean {
		const song = from.queue[fromIndex];
		if (!song) return false;
		if (from !== to && to.queue.length >= MAX_TRACK_QUEUE) return false;
		this.removeSong(from, fromIndex);
		const moved =
			gapBeforeMs === undefined ? song : { ...song, gapBeforeMs: clampLeadIn(gapBeforeMs) };
		const at = clampIndex(toIndex, to.queue.length);
		to.queue.splice(at, 0, moved);
		this.placed(to, at, now);
		return true;
	}

	/**
	 * A song was put at `index`. On a track with nothing playing, the first
	 * song's gap counts from now — which is where the editor measures it
	 * from — rather than from whenever the track went quiet.
	 */
	private placed(track: MixTrack, index: number, now: number) {
		if (track.playing || track.loading) return;
		if (index === 0 || !track.wait) track.wait = { from: this.heldAt ?? now, after: "silence" };
	}

	/** When a track's next song is due, or null when it is not waiting on one. */
	private dueAt(track: MixTrack): number | null {
		const next = track.queue[0];
		if (!track.wait || !next || track.playing || track.loading) return null;
		const gap =
			track.wait.after === "skip"
				? 0
				: (next.gapBeforeMs ?? (track.wait.after === "song" ? track.gapMs : 0));
		return track.wait.from + gap;
	}

	/** Tracks whose next song is due, held while the guild is paused. */
	due(now: number): MixTrack[] {
		if (this.held) return [];
		return this.tracks.filter((track) => {
			const dueAt = this.dueAt(track);
			return dueAt !== null && dueAt <= now;
		});
	}

	/** Take a due track's next song off its queue to fetch. Null when it has none. */
	begin(track: MixTrack): MixSong | null {
		track.wait = null;
		const song = track.queue.shift();
		if (!song) return null;
		track.loading = song;
		return song;
	}

	/**
	 * Whether `song` is still what `track` is fetching. A fetch outlives the
	 * user's patience: the track may have been removed, skipped or cleared.
	 */
	stillLoading(track: MixTrack, song: MixSong) {
		return this.tracks.includes(track) && track.loading === song;
	}

	/**
	 * The fetched song is playing on a new layer. Returns that layer's id, for
	 * the caller to send to the sidecar.
	 */
	started(track: MixTrack, song: MixSong, now: number, startMs = 0): PlayingSong {
		track.loading = null;
		track.playing = {
			...song,
			layerId: this.newLayerId(),
			startedAt: (this.heldAt ?? now) - startMs,
			startMs,
		};
		return track.playing;
	}

	/** The fetch failed: the song is dropped and the next one is tried. */
	failed(track: MixTrack, now: number) {
		track.loading = null;
		track.wait = track.queue.length ? { from: this.heldAt ?? now, after: "skip" } : null;
	}

	/** The sidecar says the layer's audio has begun: the clock starts from now. */
	layerStarted(layerId: string, now: number) {
		const playing = this.trackOfLayer(layerId)?.playing;
		if (playing) playing.startedAt = (this.heldAt ?? now) - playing.startMs;
	}

	trackOfLayer(layerId: string): MixTrack | undefined {
		return this.tracks.find((track) => track.playing?.layerId === layerId);
	}

	/**
	 * A layer ended, on its own or because it was removed. Its track waits out
	 * its gap before the next song. Returns the track, or undefined when the
	 * layer is not one of ours any more, so a late report is a no-op.
	 */
	finish(layerId: string, now: number): MixTrack | undefined {
		const track = this.trackOfLayer(layerId);
		if (!track) return undefined;
		this.retire(track);
		track.wait = track.queue.length ? { from: this.heldAt ?? now, after: "song" } : null;
		return track;
	}

	/**
	 * Move a track on to its next song now, without the gap. Returns the layer
	 * to stop, if it was playing one.
	 */
	skip(track: MixTrack, now: number): string | null {
		const layerId = track.playing?.layerId ?? null;
		this.retire(track);
		// A skip during the gap cuts the gap short.
		track.wait =
			track.queue.length && !track.loading ? { from: this.heldAt ?? now, after: "skip" } : null;
		return layerId;
	}

	/** Its song is over: back of the queue when looping, gone otherwise. */
	private retire(track: MixTrack) {
		const song = track.playing;
		track.playing = null;
		if (song && track.loop && track.queue.length < MAX_TRACK_QUEUE) {
			track.queue.push(songOf(song));
		}
	}

	/**
	 * Put another song where a track's playing one is, on a fresh layer, for a
	 * different search result. Returns the new playing song, or null when the
	 * track is not playing.
	 */
	replacePlaying(track: MixTrack, song: MixSong, now: number): PlayingSong | null {
		if (!track.playing) return null;
		return this.started(track, song, now);
	}

	/**
	 * Record a track's song trading places with the queue's: the track now
	 * plays `main`, from `positionMs`, and the volumes swap too, because each
	 * song kept its own level through the exchange. Returns what the track
	 * played before, or null if it plays nothing.
	 */
	swap(track: MixTrack, main: MixSong, positionMs: number, now: number): PlayingSong | null {
		const before = track.playing;
		if (!before) return null;
		track.playing = {
			...main,
			layerId: before.layerId,
			startedAt: (this.heldAt ?? now) - positionMs,
			startMs: 0,
		};
		const volume = track.volume;
		track.volume = this.mainVolume;
		this.mainVolume = volume;
		return before;
	}

	/**
	 * Change the track's gap. One being waited out is stretched or cut to
	 * match, unless the next song has a gap of its own.
	 */
	setGap(track: MixTrack, gapMs: number) {
		track.gapMs = clampGap(gapMs);
	}

	/** How far into its song a track is, in milliseconds. */
	position(track: MixTrack, now: number): number | null {
		if (!track.playing) return null;
		return Math.max(0, (this.heldAt ?? now) - track.playing.startedAt);
	}

	/** How long until a waiting track's next song, frozen while paused. */
	dueIn(track: MixTrack, now: number): number | null {
		const dueAt = this.dueAt(track);
		if (dueAt === null) return null;
		return Math.max(0, dueAt - (this.heldAt ?? now));
	}

	/** The guild paused: songs stop advancing and gaps stop counting down. */
	hold(now: number) {
		if (this.heldAt === null) this.heldAt = now;
	}

	release(now: number) {
		if (this.heldAt === null) return;
		const paused = now - this.heldAt;
		this.heldAt = null;
		for (const track of this.tracks) {
			if (track.playing) track.playing.startedAt += paused;
			if (track.wait) track.wait.from += paused;
		}
	}

	private newLayerId() {
		return `m${this.nextLayerId++}`;
	}
}

/** A playing song as a queue entry again, keeping its place on the timeline. */
export function songOf({ videoId, title, url, durationMs, gapBeforeMs }: MixSong): MixSong {
	return { videoId, title, url, durationMs, ...(gapBeforeMs === undefined ? {} : { gapBeforeMs }) };
}

/** A track's gap as the mix allows it: whole milliseconds, from none to `MAX_GAP_MS`. */
export function clampGap(gapMs: number, max = MAX_GAP_MS) {
	return Number.isFinite(gapMs) ? Math.min(Math.max(0, Math.round(gapMs)), max) : 0;
}

/** A song's own lead-in as the mix allows it, up to `MAX_LEAD_IN_MS`. */
export function clampLeadIn(gapMs: number) {
	return clampGap(gapMs, MAX_LEAD_IN_MS);
}

function clampIndex(index: number, length: number) {
	return Number.isFinite(index) ? Math.min(Math.max(0, Math.floor(index)), length) : length;
}

/** A user's percent as the sidecar's linear gain. */
export function gainFromPercent(volume: number) {
	return Math.max(0, volume) / 100;
}
