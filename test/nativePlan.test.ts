import { describe, expect, test } from "bun:test";
import {
	NativePlayback,
	planArm,
	positionFrom,
	PROMOTION_GRACE_MS,
	shouldSendPlay,
} from "../lib/voice/nativePlan";

/**
 * The rules the sidecar playback path runs on.
 *
 * These are exercised here rather than through `CustomAudioPlayer` because
 * that class reaches @distube/ytdl-core through its imports, which cannot load
 * under Bun at all. What is left is the part with the failure modes: arming
 * the wrong track, restarting one that is already playing, and reporting a
 * position that keeps climbing while paused.
 */

describe("planArm", () => {
	test("arms the queue head once it is cached", () => {
		expect(planArm("nextTrack1", null)).toEqual({
			action: "arm",
			trackId: "nextTrack1",
		});
	});

	test("says nothing when the armed track is still the right one", () => {
		// This runs on every position report — about once a second for the
		// whole track — so re-sending setNext would rebuild the standby
		// reader over and over for no reason.
		expect(planArm("nextTrack1", "nextTrack1")).toEqual({ action: "none" });
	});

	test("re-arms when the queue head changes", () => {
		expect(planArm("newHead0001", "oldHead0001")).toEqual({
			action: "arm",
			trackId: "newHead0001",
		});
	});

	test("clears a stale arm when the queue empties", () => {
		// Removing the last queued song must take the standby slot with it,
		// or the sidecar would slide into a track that is no longer queued.
		expect(planArm(null, "oldHead0001")).toEqual({ action: "clear" });
	});

	test("does not clear when there was nothing armed", () => {
		expect(planArm(null, null)).toEqual({ action: "none" });
	});
});

describe("shouldSendPlay", () => {
	const at = 100_000;

	test("does not restart a track the sidecar already promoted", () => {
		// The promotion is the crossfade. A play here would cut it off and
		// start the incoming track again from zero.
		expect(
			shouldSendPlay({ trackId: "nextTrack1", at }, "nextTrack1", 0, at + 200),
		).toBe(false);
	});

	test("plays a track that was never armed", () => {
		expect(shouldSendPlay(null, "someTrack1", 0, at)).toBe(true);
	});

	test("plays when a different track was promoted", () => {
		// A skip past the queue head, for instance: the promoted track is not
		// the one being started.
		expect(
			shouldSendPlay({ trackId: "armedTrack", at }, "otherTrack", 0, at + 200),
		).toBe(true);
	});

	test("plays a promoted track when it must start part-way in", () => {
		// A seek or a segment skip. The sidecar promoted to zero, so the
		// position it is at is not the one being asked for.
		expect(
			shouldSendPlay(
				{ trackId: "nextTrack1", at },
				"nextTrack1",
				30_000,
				at + 200,
			),
		).toBe(true);
	});

	test("plays when the promotion is too old to still be true", () => {
		// The advance that promotion belongs to takes well under a second. A
		// minute later it means the advance never finished — the sidecar is
		// not playing this — and suppressing the play would be silence.
		expect(
			shouldSendPlay(
				{ trackId: "nextTrack1", at },
				"nextTrack1",
				0,
				at + PROMOTION_GRACE_MS + 1,
			),
		).toBe(true);
	});
});

describe("positionFrom", () => {
	test("carries the position forward between reports", () => {
		// Reports arrive about once a second; a progress bar and a segment
		// timer both need finer than that.
		expect(positionFrom({ ms: 5_000, at: 1_000 }, false, 1_750)).toBe(5_750);
	});

	test("freezes while paused", () => {
		// No report arrives while paused, so time passing is not progress.
		expect(positionFrom({ ms: 5_000, at: 1_000 }, true, 60_000)).toBe(5_000);
	});

	test("reports zero rather than nothing at the start of a track", () => {
		// Zero is a real position: a segment beginning at 0:00 is detected
		// from it, and treating it as absent is what broke that once already.
		expect(positionFrom({ ms: 0, at: 1_000 }, false, 1_000)).toBe(0);
	});

	test("has no answer before the first anchor", () => {
		expect(positionFrom(null, false, 1_000)).toBeNull();
	});

	test("never goes backwards if a report arrives out of order", () => {
		// Clamped rather than trusted: a negative elapsed would make the
		// position jump back and re-fire segment timers already dealt with.
		expect(positionFrom({ ms: 5_000, at: 2_000 }, false, 1_000)).toBe(5_000);
	});
});

describe("NativePlayback", () => {
	test("starts with nothing armed, anchored, or promoted", () => {
		const playback = new NativePlayback();
		expect(playback.armed).toBeNull();
		expect(playback.anchor).toBeNull();
		expect(playback.promoted).toBeNull();
		expect(playback.positionAt(false, 1_000)).toBeNull();
	});

	test("clears all three at once", () => {
		// They were three fields on the player, cleared in three separate
		// places — and one of those places having missed a field is why they
		// are one object now.
		const playback = new NativePlayback();
		playback.armed = "nextTrack1";
		playback.anchorAt(5_000, 1_000);
		playback.promote(2_000);

		playback.clear();

		expect(playback.armed).toBeNull();
		expect(playback.anchor).toBeNull();
		expect(playback.promoted).toBeNull();
	});

	test("promotes the armed track and stops considering it armed", () => {
		// The seam: the sidecar moved to the standby track the instant the
		// last one ended, so it is playing now rather than standing by.
		const playback = new NativePlayback();
		playback.armed = "nextTrack1";

		playback.promote(9_000);

		expect(playback.promoted).toEqual({ trackId: "nextTrack1", at: 9_000 });
		expect(playback.armed).toBeNull();
	});

	test("promotes nothing when nothing was armed", () => {
		const playback = new NativePlayback();
		playback.promote(9_000);
		expect(playback.promoted).toBeNull();
	});

	test("hands over a promotion once", () => {
		// shouldSendPlay weighs it, and the track after must not be weighed
		// against the previous one's promotion.
		const playback = new NativePlayback();
		playback.armed = "nextTrack1";
		playback.promote(9_000);

		expect(playback.takePromotion()).toEqual({
			trackId: "nextTrack1",
			at: 9_000,
		});
		expect(playback.takePromotion()).toBeNull();
	});

	test("carries the position on the wall clock between reports", () => {
		const playback = new NativePlayback();
		playback.anchorAt(5_000, 1_000);

		expect(playback.positionAt(false, 3_000)).toBe(7_000);
		expect(playback.positionAt(true, 3_000)).toBe(5_000);
	});

	test("restarts the clock on resume without moving the position", () => {
		// Time was not running during the pause, and the last report arrived
		// before it — so counting from that report would jump the position
		// forward by however long the pause lasted.
		const playback = new NativePlayback();
		playback.anchorAt(5_000, 1_000);

		playback.resumeAt(60_000);

		expect(playback.positionAt(false, 60_000)).toBe(5_000);
		expect(playback.positionAt(false, 61_000)).toBe(6_000);
	});

	test("resuming before any report anchors nothing", () => {
		const playback = new NativePlayback();
		playback.resumeAt(60_000);
		expect(playback.anchor).toBeNull();
	});
});
