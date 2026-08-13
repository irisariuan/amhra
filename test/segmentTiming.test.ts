import { describe, expect, test } from "bun:test";
import type { Segment } from "../lib/voice/segment";
import { segmentAt, upcomingSegments } from "../lib/voice/segmentTiming";

/**
 * The regression these guard: position zero is a real position.
 *
 * Both of these checks used to treat a falsy position as "nothing is playing".
 * A track that has just started is at exactly zero, so switching tracks left
 * the new one with no segment timers, and a non-music segment beginning at
 * 0:00 — the usual place for one — was never detected.
 */

/**
 * A SponsorBlock segment, built here rather than imported.
 *
 * `lib/voice/segment.ts` reaches @distube/ytdl-core through its imports, which
 * cannot be loaded under Bun at all — and this is pure arithmetic over two
 * numbers, so it should not need a YouTube client to test.
 */
function segment(startSec: number, endSec: number): Segment {
	return {
		category: "music_offtopic",
		actionType: "skip",
		segment: [startSec, endSec],
		UUID: `${startSec}-${endSec}`,
		videoDuration: 300,
		locked: 0,
		votes: 0,
		description: "",
	} as unknown as Segment;
}

describe("segmentAt", () => {
	test("finds a segment that starts at zero", () => {
		// The case that was invisible: a track opening with a non-music intro,
		// checked at the instant it starts.
		const found = segmentAt([segment(0, 12)], 0);
		expect(found).not.toBeNull();
		expect(found?.segment).toEqual([0, 12]);
	});

	test("finds the segment covering the current position", () => {
		const segments = [segment(0, 5), segment(30, 45)];
		expect(segmentAt(segments, 35_000)?.segment).toEqual([30, 45]);
	});

	test("includes both edges of a segment", () => {
		const segments = [segment(10, 20)];
		expect(segmentAt(segments, 10_000)).not.toBeNull();
		expect(segmentAt(segments, 20_000)).not.toBeNull();
		expect(segmentAt(segments, 20_001)).toBeNull();
	});

	test("returns nothing between segments", () => {
		expect(segmentAt([segment(0, 5), segment(30, 45)], 12_000)).toBeNull();
	});

	test("returns nothing when there is no position or no segments", () => {
		// null means nothing is playing, which is different from position zero.
		expect(segmentAt([segment(0, 5)], null)).toBeNull();
		expect(segmentAt(null, 0)).toBeNull();
		expect(segmentAt([], 0)).toBeNull();
	});
});

describe("upcomingSegments", () => {
	test("schedules every segment of a track that just started", () => {
		// This is the switched-to-a-new-track case: at position zero, all of
		// them are still ahead.
		const segments = [segment(0, 10), segment(60, 75), segment(200, 210)];
		const upcoming = upcomingSegments(segments, 0);

		expect(upcoming).toHaveLength(3);
		expect(upcoming.map((entry) => entry.delayMs)).toEqual([0, 60_000, 200_000]);
	});

	test("skips segments already behind the position", () => {
		const segments = [segment(0, 10), segment(60, 75), segment(200, 210)];
		const upcoming = upcomingSegments(segments, 90_000);

		expect(upcoming).toHaveLength(1);
		expect(upcoming[0].delayMs).toBe(110_000);
	});

	test("does not schedule a segment that is already in progress", () => {
		// Mid-segment, the caller should act now rather than wait: that is
		// segmentAt's job, and scheduling it here would fire it twice.
		const upcoming = upcomingSegments([segment(60, 75)], 65_000);
		expect(upcoming).toHaveLength(0);
		expect(segmentAt([segment(60, 75)], 65_000)).not.toBeNull();
	});

	test("returns nothing when there is no position or no segments", () => {
		expect(upcomingSegments([segment(10, 20)], null)).toEqual([]);
		expect(upcomingSegments(null, 0)).toEqual([]);
		expect(upcomingSegments(undefined, 0)).toEqual([]);
	});
});
