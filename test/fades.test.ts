import { describe, expect, test } from "bun:test";
import {
	DEFAULT_FADES,
	fadesFrom,
	nextFades,
	syncedFades,
} from "../lib/voice/fades";

/**
 * A guild's crossfade is adjustable live from the dashboard, the way volume
 * is, on top of the global default in the settings page. Two rules carry that,
 * and both fail quietly rather than loudly when wrong.
 */

const current = { crossfadeMs: 3_000, skipFadeMs: 40 };

describe("nextFades", () => {
	test("moves one slider without disturbing the other", () => {
		// The regression this guards: two independent controls, where writing
		// one would otherwise reset the half the request never mentioned.
		expect(nextFades(current, { crossfadeMs: 5_000 })).toEqual({
			crossfadeMs: 5_000,
			skipFadeMs: 40,
		});
		expect(nextFades(current, { skipFadeMs: 200 })).toEqual({
			crossfadeMs: 3_000,
			skipFadeMs: 200,
		});
	});

	test("takes zero as a value, not as an omission", () => {
		// Zero crossfade is the hard cut, which is a setting someone chooses,
		// not the absence of one.
		expect(nextFades(current, { crossfadeMs: 0 }).crossfadeMs).toBe(0);
	});

	test("moves both at once", () => {
		expect(nextFades(current, { crossfadeMs: 1_500, skipFadeMs: 0 })).toEqual({
			crossfadeMs: 1_500,
			skipFadeMs: 0,
		});
	});

	test("keeps the values whole and non-negative", () => {
		// They cross a process boundary into a u16; a negative or fractional
		// millisecond is not something the sidecar can be handed.
		expect(nextFades(current, { crossfadeMs: -500 }).crossfadeMs).toBe(0);
		expect(nextFades(current, { crossfadeMs: 1_499.6 }).crossfadeMs).toBe(1_500);
	});

	test("ignores a value that is not a number at all", () => {
		expect(nextFades(current, { crossfadeMs: Number.NaN }).crossfadeMs).toBe(
			3_000,
		);
	});

	test("changes nothing when given nothing", () => {
		expect(nextFades(current, {})).toEqual(current);
	});
});

describe("syncedFades", () => {
	const fromSetting = { crossfadeMs: 800, skipFadeMs: 60 };

	test("an untouched guild follows a changed default", () => {
		expect(syncedFades(current, false, fromSetting)).toEqual(fromSetting);
	});

	test("an adjusted guild keeps what it was given", () => {
		// Saving an unrelated field on the settings page must not undo a live
		// adjustment, the same way it does not reset a guild's volume.
		expect(syncedFades(current, true, fromSetting)).toBeNull();
	});

	test("says nothing to do when the default already matches", () => {
		// The caller pushes what it gets across a process boundary, so a
		// no-op has to be distinguishable from a change to the same numbers.
		expect(syncedFades(current, false, { ...current })).toBeNull();
	});
});

describe("fadesFrom", () => {
	test("falls back to a hard cut and a short skip fade", () => {
		expect(fadesFrom({})).toEqual(DEFAULT_FADES);
		expect(DEFAULT_FADES.crossfadeMs).toBe(0);
	});

	test("reads both values when the setting has them", () => {
		expect(
			fadesFrom({ CROSSFADE_IN_MS: 2_000, SKIP_FADE_IN_MS: 100 }),
		).toEqual({ crossfadeMs: 2_000, skipFadeMs: 100 });
	});

	test("keeps a configured zero rather than treating it as unset", () => {
		// Someone who set the skip fade to zero wants no fade, not the 40ms
		// default back.
		expect(fadesFrom({ SKIP_FADE_IN_MS: 0 }).skipFadeMs).toBe(0);
	});
});
