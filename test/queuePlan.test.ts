import { describe, expect, test } from "bun:test";
import {
	clampGap,
	clampLeadIn,
	dueAt,
	dueIn,
	freeQueueNumber,
	gapBefore,
	MAX_GAP_MS,
	MAX_LEAD_IN_MS,
	MAX_QUEUES,
} from "../lib/voice/queuePlan";

describe("the gap before a song", () => {
	test("after a song, the queue's gap", () => {
		expect(gapBefore("song", 3_000, {})).toBe(3_000);
	});

	test("a song's own lead-in wins over the queue's gap", () => {
		expect(gapBefore("song", 3_000, { gapBeforeMs: 500 })).toBe(500);
		expect(gapBefore("song", 3_000, { gapBeforeMs: 0 })).toBe(0);
	});

	test("on a silent queue, only the song's own lead-in", () => {
		// The queue's gap is between songs; a first song does not wait it out.
		expect(gapBefore("silence", 3_000, {})).toBe(0);
		expect(gapBefore("silence", 3_000, { gapBeforeMs: 40_000 })).toBe(40_000);
	});

	test("a skip cuts it short", () => {
		expect(gapBefore("skip", 3_000, { gapBeforeMs: 40_000 })).toBe(0);
	});

	test("nothing next, nothing to wait for", () => {
		expect(gapBefore("song", 3_000, undefined)).toBe(0);
		expect(dueAt({ from: 0, after: "song" }, 3_000, undefined)).toBeNull();
	});
});

describe("when the next song is due", () => {
	test("counts from the start of the wait", () => {
		expect(dueAt({ from: 10_000, after: "song" }, 3_000, {})).toBe(13_000);
		expect(dueAt(null, 3_000, {})).toBeNull();
	});

	test("the countdown never goes below zero", () => {
		expect(dueIn({ from: 0, after: "song" }, 3_000, {}, 1_000, null)).toBe(2_000);
		expect(dueIn({ from: 0, after: "song" }, 3_000, {}, 9_000, null)).toBe(0);
	});

	test("the countdown stops where the queue was paused", () => {
		expect(dueIn({ from: 0, after: "song" }, 3_000, {}, 60_000, 1_000)).toBe(2_000);
	});
});

describe("queue numbers", () => {
	test("the lowest free one above 1", () => {
		expect(freeQueueNumber([])).toBe(2);
		expect(freeQueueNumber([2, 3, 5])).toBe(4);
	});

	test("none once the guild has them all", () => {
		const all = Array.from({ length: MAX_QUEUES - 1 }, (_, i) => i + 2);
		expect(freeQueueNumber(all)).toBeNull();
	});
});

describe("clamping", () => {
	test("gaps", () => {
		expect(clampGap(-5)).toBe(0);
		expect(clampGap(1.6)).toBe(2);
		expect(clampGap(Number.NaN)).toBe(0);
		expect(clampGap(MAX_GAP_MS + 1)).toBe(MAX_GAP_MS);
	});

	test("lead-ins go far past a gap", () => {
		expect(clampLeadIn(MAX_GAP_MS * 3)).toBe(MAX_GAP_MS * 3);
		expect(clampLeadIn(MAX_LEAD_IN_MS + 1)).toBe(MAX_LEAD_IN_MS);
	});
});
