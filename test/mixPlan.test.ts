import { describe, expect, test } from "bun:test";
import {
	gainFromPercent,
	GuildMix,
	MAX_GAP_MS,
	MAX_LEAD_IN_MS,
	MAX_TRACK_QUEUE,
	MAX_TRACKS,
	type MixSong,
	type MixTrack,
} from "../lib/voice/mixPlan";

/**
 * The bot's record of the tracks each guild has mixed in over its queue. The
 * audio is the sidecar's; what can go wrong here is a track starting its next
 * song at the wrong time, naming the wrong one, or a late report from the
 * sidecar moving on a track that has already moved.
 */

const song = (n: number): MixSong => ({
	videoId: `video${n}`,
	title: `Song ${n}`,
	url: `https://youtu.be/video${n}`,
	durationMs: 60_000,
});

/** Take a due track through its fetch to playing, as the sweep does. */
function play(mix: GuildMix, track: MixTrack, now: number) {
	const next = mix.begin(track)!;
	return mix.started(track, next, now);
}

describe("GuildMix tracks", () => {
	test("lists tracks in the order they were made, by 1-based position", () => {
		const mix = new GuildMix();
		const first = mix.addTrack()!;
		const second = mix.addTrack({ volume: 30 })!;
		expect(mix.at(1)).toBe(first);
		expect(mix.at(2)).toBe(second);
		expect(mix.at(0)).toBeUndefined();
		expect(mix.at(3)).toBeUndefined();
		expect(mix.at(1.5)).toBeUndefined();
		expect(mix.positionOf(second)).toBe(2);
		expect(second.volume).toBe(30);
		expect(first.volume).toBe(100);
	});

	test("refuses a track past the sidecar's layer cap", () => {
		const mix = new GuildMix();
		for (let n = 0; n < MAX_TRACKS; n++) expect(mix.addTrack()).not.toBeNull();
		expect(mix.isFull()).toBe(true);
		expect(mix.addTrack()).toBeNull();
	});

	test("never reuses a track id", () => {
		const mix = new GuildMix();
		const first = mix.addTrack()!;
		mix.removeTrack(first);
		expect(mix.addTrack()!.id).not.toBe(first.id);
	});

	test("clamps the gap to what is allowed", () => {
		const mix = new GuildMix();
		expect(mix.addTrack({ gapMs: -5 })!.gapMs).toBe(0);
		expect(mix.addTrack({ gapMs: MAX_GAP_MS * 2 })!.gapMs).toBe(MAX_GAP_MS);
		expect(mix.addTrack({ gapMs: Number.NaN })!.gapMs).toBe(0);
	});
});

describe("a track's queue", () => {
	test("a silent track plays what is queued at once, with no gap first", () => {
		const mix = new GuildMix();
		const track = mix.addTrack({ gapMs: 5_000 })!;
		expect(mix.due(0)).toEqual([]);
		mix.enqueue(track, song(1), 1_000);
		expect(mix.due(1_000)).toEqual([track]);
	});

	test("waits out the gap between one song and the next", () => {
		const mix = new GuildMix();
		const track = mix.addTrack({ gapMs: 5_000 })!;
		mix.enqueue(track, song(1), 0);
		mix.enqueue(track, song(2), 0);
		const first = play(mix, track, 0);
		expect(mix.due(0)).toEqual([]);

		expect(mix.finish(first.layerId, 60_000)).toBe(track);
		expect(track.playing).toBeNull();
		expect(mix.dueIn(track, 60_000)).toBe(5_000);
		expect(mix.due(64_999)).toEqual([]);
		expect(mix.due(65_000)).toEqual([track]);
		expect(play(mix, track, 65_000).title).toBe("Song 2");
	});

	test("goes quiet when its queue runs out", () => {
		const mix = new GuildMix();
		const track = mix.addTrack({ gapMs: 1_000 })!;
		mix.enqueue(track, song(1), 0);
		const first = play(mix, track, 0);
		mix.finish(first.layerId, 10);
		expect(track.wait).toBeNull();
		expect(mix.busy()).toBe(false);

		// And wakes when something is queued again
		mix.enqueue(track, song(2), 20);
		expect(mix.due(20)).toEqual([track]);
	});

	test("a looping track puts each song that ends at the back", () => {
		const mix = new GuildMix();
		const track = mix.addTrack({ loop: true })!;
		mix.enqueue(track, song(1), 0);
		mix.enqueue(track, song(2), 0);
		const first = play(mix, track, 0);
		mix.finish(first.layerId, 1);
		expect(track.queue.map((s) => s.title)).toEqual(["Song 2", "Song 1"]);
		// Without the layer details it was playing under
		expect(track.queue[1]).toEqual(song(1));
	});

	test("a single looping song plays again after the gap", () => {
		const mix = new GuildMix();
		const track = mix.addTrack({ loop: true, gapMs: 2_000 })!;
		mix.enqueue(track, song(1), 0);
		const first = play(mix, track, 0);
		mix.finish(first.layerId, 60_000);
		expect(mix.due(62_000)).toEqual([track]);
	});

	test("a late report from a layer already replaced does nothing", () => {
		// Skipping removes the layer, whose layerFinished lands a frame later,
		// by which point the next song may already be playing.
		const mix = new GuildMix();
		const track = mix.addTrack()!;
		mix.enqueue(track, song(1), 0);
		mix.enqueue(track, song(2), 0);
		const first = play(mix, track, 0);
		expect(mix.skip(track, 10)).toBe(first.layerId);
		const second = play(mix, track, 10);
		expect(second.layerId).not.toBe(first.layerId);

		expect(mix.finish(first.layerId, 20)).toBeUndefined();
		expect(track.playing).toBe(second);
	});

	test("a skip moves on at once, cutting any gap short", () => {
		const mix = new GuildMix();
		const track = mix.addTrack({ gapMs: 30_000 })!;
		mix.enqueue(track, song(1), 0);
		mix.enqueue(track, song(2), 0);
		mix.enqueue(track, song(3), 0);
		play(mix, track, 0);
		mix.skip(track, 100);
		expect(mix.due(100)).toEqual([track]);

		const second = play(mix, track, 100);
		mix.finish(second.layerId, 200);
		expect(mix.due(200)).toEqual([]);
		mix.skip(track, 300);
		expect(mix.due(300)).toEqual([track]);
	});

	test("a track being fetched is not started twice", () => {
		const mix = new GuildMix();
		const track = mix.addTrack()!;
		mix.enqueue(track, song(1), 0);
		const fetching = mix.begin(track)!;
		mix.enqueue(track, song(2), 0);
		expect(mix.due(0)).toEqual([]);
		expect(mix.stillLoading(track, fetching)).toBe(true);
	});

	test("a fetch that outlives its track is not started", () => {
		const mix = new GuildMix();
		const track = mix.addTrack()!;
		mix.enqueue(track, song(1), 0);
		const fetching = mix.begin(track)!;
		mix.removeTrack(track);
		expect(mix.stillLoading(track, fetching)).toBe(false);
	});

	test("a failed fetch moves on to the next song", () => {
		const mix = new GuildMix();
		const track = mix.addTrack({ gapMs: 10_000 })!;
		mix.enqueue(track, song(1), 0);
		mix.enqueue(track, song(2), 0);
		mix.begin(track);
		mix.failed(track, 5);
		expect(mix.due(5)).toEqual([track]);
		expect(mix.begin(track)?.title).toBe("Song 2");
	});

	test("caps a track's queue", () => {
		const mix = new GuildMix();
		const track = mix.addTrack()!;
		mix.begin(track);
		for (let n = 0; n < MAX_TRACK_QUEUE; n++) expect(mix.enqueue(track, song(n), 0)).toBe(true);
		expect(mix.enqueue(track, song(999), 0)).toBe(false);
	});

	test("queues at an index, clamped to the queue", () => {
		const mix = new GuildMix();
		const track = mix.addTrack()!;
		mix.enqueue(track, song(1), 0);
		mix.begin(track);
		mix.enqueue(track, song(2), 0);
		mix.enqueue(track, song(3), 0, 0);
		mix.enqueue(track, song(4), 0, 99);
		expect(track.queue.map((s) => s.title)).toEqual(["Song 3", "Song 2", "Song 4"]);
	});
});

describe("moving songs", () => {
	test("along a track", () => {
		const mix = new GuildMix();
		const track = mix.addTrack()!;
		mix.enqueue(track, song(0), 0);
		mix.begin(track);
		for (const n of [1, 2, 3]) mix.enqueue(track, song(n), 0);
		expect(mix.moveSong(track, 0, track, 2, 0)).toBe(true);
		expect(track.queue.map((s) => s.title)).toEqual(["Song 2", "Song 3", "Song 1"]);
	});

	test("onto a silent track starts it there", () => {
		const mix = new GuildMix();
		const from = mix.addTrack()!;
		const to = mix.addTrack()!;
		mix.enqueue(from, song(0), 0);
		play(mix, from, 0);
		mix.enqueue(from, song(1), 0);
		expect(mix.moveSong(from, 0, to, 0, 50)).toBe(true);
		expect(from.queue).toEqual([]);
		expect(mix.due(50)).toEqual([to]);
	});

	test("refuses a song that is not there", () => {
		const mix = new GuildMix();
		const track = mix.addTrack()!;
		expect(mix.moveSong(track, 0, track, 0, 0)).toBe(false);
	});

	test("removing the last waiting song stops the wait", () => {
		const mix = new GuildMix();
		const track = mix.addTrack({ gapMs: 5_000 })!;
		mix.enqueue(track, song(1), 0);
		mix.enqueue(track, song(2), 0);
		const first = play(mix, track, 0);
		mix.finish(first.layerId, 1);
		expect(mix.removeSong(track, 0)?.title).toBe("Song 2");
		expect(track.wait).toBeNull();
		expect(mix.busy()).toBe(false);
		expect(mix.removeSong(track, 0)).toBeNull();
	});
});

describe("a song's own gap", () => {
	// Set by where the song was dropped on the editor's timeline, so it lines
	// up with a song on another lane.
	test("waits its own gap after the song before, in place of the track's", () => {
		const mix = new GuildMix();
		const track = mix.addTrack({ gapMs: 5_000 })!;
		mix.enqueue(track, song(1), 0);
		mix.enqueue(track, { ...song(2), gapBeforeMs: 20_000 }, 0);
		mix.enqueue(track, song(3), 0);
		const first = play(mix, track, 0);
		mix.finish(first.layerId, 60_000);
		expect(mix.dueIn(track, 60_000)).toBe(20_000);

		const second = play(mix, track, 80_000);
		mix.finish(second.layerId, 140_000);
		// The next one is back to the track's gap
		expect(mix.dueIn(track, 140_000)).toBe(5_000);
	});

	test("on a silent track, it is how long to wait from now", () => {
		const mix = new GuildMix();
		const track = mix.addTrack({ gapMs: 5_000 })!;
		mix.enqueue(track, { ...song(1), gapBeforeMs: 30_000 }, 1_000);
		expect(mix.due(30_999)).toEqual([]);
		expect(mix.due(31_000)).toEqual([track]);
		expect(mix.busy()).toBe(true);
	});

	test("a move sets it, counted from now when it lands first on a quiet track", () => {
		// The editor measures a drop on a quiet lane from the playhead, not
		// from whenever the lane last played.
		const mix = new GuildMix();
		const from = mix.addTrack()!;
		const to = mix.addTrack({ gapMs: 8_000 })!;
		mix.enqueue(from, song(0), 0);
		play(mix, from, 0);
		mix.enqueue(from, song(1), 0);
		mix.enqueue(to, song(2), 0);
		const layer = play(mix, to, 0);
		mix.enqueue(to, song(3), 0);
		mix.finish(layer.layerId, 10_000);

		expect(mix.moveSong(from, 0, to, 0, 12_000, 4_000)).toBe(true);
		expect(to.queue[0]).toEqual({ ...song(1), gapBeforeMs: 4_000 });
		expect(mix.dueIn(to, 12_000)).toBe(4_000);
	});

	test("may be far longer than a track's gap", () => {
		// Dropped after a long queue on another lane, a song can start an
		// hour out; a track's own gap stays capped at ten minutes.
		const mix = new GuildMix();
		const from = mix.addTrack()!;
		const to = mix.addTrack({ gapMs: MAX_GAP_MS * 2 })!;
		expect(to.gapMs).toBe(MAX_GAP_MS);
		mix.enqueue(from, song(0), 0);
		play(mix, from, 0);
		mix.enqueue(from, song(1), 0);
		mix.moveSong(from, 0, to, 0, 0, 72 * 60_000);
		expect(mix.dueIn(to, 0)).toBe(72 * 60_000);
		mix.enqueue(from, song(2), 0);
		mix.moveSong(from, 0, to, 0, 0, MAX_LEAD_IN_MS * 2);
		expect(to.queue[0].gapBeforeMs).toBe(MAX_LEAD_IN_MS);
	});

	test("a move without one keeps the song's own", () => {
		const mix = new GuildMix();
		const track = mix.addTrack()!;
		mix.enqueue(track, song(0), 0);
		play(mix, track, 0);
		mix.enqueue(track, { ...song(1), gapBeforeMs: 2_000 }, 0);
		mix.enqueue(track, song(2), 0);
		mix.moveSong(track, 0, track, 1, 0);
		expect(track.queue[1].gapBeforeMs).toBe(2_000);
	});

	test("a skip ignores it, and a loop keeps it", () => {
		const mix = new GuildMix();
		const track = mix.addTrack({ loop: true })!;
		mix.enqueue(track, { ...song(1), gapBeforeMs: 9_000 }, 0);
		mix.enqueue(track, { ...song(2), gapBeforeMs: 9_000 }, 0);
		const first = play(mix, track, 9_000);
		mix.skip(track, 10_000);
		expect(mix.due(10_000)).toEqual([track]);
		expect(track.queue.at(-1)?.gapBeforeMs).toBe(9_000);
		expect(first.title).toBe("Song 1");
	});

	test("a track's gap change applies to a wait already under way", () => {
		const mix = new GuildMix();
		const track = mix.addTrack({ gapMs: 10_000 })!;
		mix.enqueue(track, song(1), 0);
		mix.enqueue(track, song(2), 0);
		mix.finish(play(mix, track, 0).layerId, 0);
		mix.setGap(track, 2_000);
		expect(mix.dueIn(track, 0)).toBe(2_000);
	});
});

describe("pausing", () => {
	test("holds songs' positions and gaps until the guild resumes", () => {
		const mix = new GuildMix();
		const playing = mix.addTrack()!;
		const waiting = mix.addTrack({ gapMs: 10_000 })!;
		mix.enqueue(playing, song(1), 0);
		play(mix, playing, 0);
		mix.enqueue(waiting, song(2), 0);
		mix.enqueue(waiting, song(3), 0);
		const layer = play(mix, waiting, 0);
		mix.finish(layer.layerId, 1_000);

		mix.hold(4_000);
		expect(mix.position(playing, 9_000)).toBe(4_000);
		expect(mix.dueIn(waiting, 9_000)).toBe(7_000);
		expect(mix.due(20_000)).toEqual([]);

		mix.release(14_000);
		expect(mix.position(playing, 14_000)).toBe(4_000);
		expect(mix.due(20_999)).toEqual([]);
		expect(mix.due(21_000)).toEqual([waiting]);
	});

	test("a layer that starts late starts its clock late", () => {
		// Streaming, the audio begins only once the sidecar has fetched it.
		const mix = new GuildMix();
		const track = mix.addTrack()!;
		mix.enqueue(track, song(1), 0);
		const layer = play(mix, track, 0);
		mix.layerStarted(layer.layerId, 2_000);
		expect(mix.position(track, 3_000)).toBe(1_000);
	});

	test("setting the gap mid-wait moves when the next song is due", () => {
		const mix = new GuildMix();
		const track = mix.addTrack({ gapMs: 10_000 })!;
		mix.enqueue(track, song(1), 0);
		mix.enqueue(track, song(2), 0);
		const layer = play(mix, track, 0);
		mix.finish(layer.layerId, 0);
		mix.setGap(track, 2_000);
		expect(mix.dueIn(track, 0)).toBe(2_000);
	});
});

describe("clearing", () => {
	test("returns every layer to stop and leaves nothing to start", () => {
		const mix = new GuildMix();
		const a = mix.addTrack()!;
		const b = mix.addTrack()!;
		mix.enqueue(a, song(1), 0);
		mix.enqueue(b, song(2), 0);
		const layer = play(mix, a, 0);
		expect(mix.clear()).toEqual([layer.layerId]);
		expect(mix.size).toBe(0);
		expect(mix.due(0)).toEqual([]);
		expect(mix.finish(layer.layerId, 0)).toBeUndefined();
	});

	test("starts the queue song at full volume", () => {
		expect(new GuildMix().mainVolume).toBe(100);
	});
});

describe("gainFromPercent", () => {
	test("turns a percent into the sidecar's linear gain", () => {
		expect(gainFromPercent(100)).toBe(1);
		expect(gainFromPercent(250)).toBe(2.5);
		expect(gainFromPercent(-10)).toBe(0);
	});
});
