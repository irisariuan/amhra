import { describe, expect, test } from "bun:test";
import {
	type LeaveLimits,
	type LeaveState,
	planLeave,
} from "../lib/voice/leavePlan";

/**
 * The rules behind the bot taking itself out of a voice channel.
 *
 * Each of these is a way the old one-shot timers got it wrong, so they are
 * written as the situation rather than as the branch.
 */

const limits: LeaveLimits = {
	inactivityMs: 15 * 60 * 1000,
	aloneMs: 60 * 1000,
};

const now = 1_000_000;

function state(over: Partial<LeaveState> = {}): LeaveState {
	return {
		busy: false,
		listeners: 2,
		idleSince: null,
		aloneSince: null,
		...over,
	};
}

describe("leaving for inactivity", () => {
	test("starts the clock the first sweep that sees the player idle", () => {
		expect(planLeave(state(), limits, now)).toEqual({
			action: "wait",
			idleSince: now,
			aloneSince: null,
		});
	});

	test("keeps the original timestamp across sweeps", () => {
		// Re-stamping every sweep is how an idle player would never age.
		expect(
			planLeave(state({ idleSince: now - 60_000 }), limits, now),
		).toEqual({ action: "wait", idleSince: now - 60_000, aloneSince: null });
	});

	test("leaves once the idle time is up", () => {
		expect(
			planLeave(
				state({ idleSince: now - limits.inactivityMs }),
				limits,
				now,
			),
		).toEqual({ action: "leave", reason: "inactivity" });
	});

	test("drops the clock as soon as something plays", () => {
		expect(
			planLeave(
				state({ busy: true, idleSince: now - limits.inactivityMs }),
				limits,
				now,
			),
		).toEqual({ action: "wait", idleSince: null, aloneSince: null });
	});

	test("counts a paused player as idle", () => {
		// The bug this whole module replaces: starting a track cleared the
		// pending timer and pausing armed nothing, so a paused bot stayed in
		// the channel indefinitely.
		const paused = state({ busy: false, idleSince: now - limits.inactivityMs });
		expect(planLeave(paused, limits, now)).toEqual({
			action: "leave",
			reason: "inactivity",
		});
	});

	test("never leaves when the limit is negative", () => {
		const off = { ...limits, inactivityMs: -1 };
		expect(
			planLeave(state({ idleSince: now - 10 * 60 * 60 * 1000 }), off, now),
		).toEqual({
			action: "wait",
			idleSince: now - 10 * 60 * 60 * 1000,
			aloneSince: null,
		});
	});

	test("leaves on the first idle sweep when the limit is zero", () => {
		expect(planLeave(state(), { ...limits, inactivityMs: 0 }, now)).toEqual({
			action: "leave",
			reason: "inactivity",
		});
	});
});

describe("leaving an empty channel", () => {
	test("starts the clock the first sweep with nobody listening", () => {
		expect(planLeave(state({ listeners: 0, busy: true }), limits, now)).toEqual(
			{ action: "wait", idleSince: null, aloneSince: now },
		);
	});

	test("leaves a channel that has been empty long enough, even mid-song", () => {
		// Playing to nobody is exactly the case the inactivity timer cannot
		// catch, because the player is busy the whole time.
		expect(
			planLeave(
				state({ listeners: 0, busy: true, aloneSince: now - limits.aloneMs }),
				limits,
				now,
			),
		).toEqual({ action: "leave", reason: "alone" });
	});

	test("drops the clock when somebody comes back", () => {
		expect(
			planLeave(
				state({ listeners: 1, aloneSince: now - limits.aloneMs }),
				limits,
				now,
			),
		).toEqual({ action: "wait", idleSince: now, aloneSince: null });
	});

	test("treats an unreadable channel as unknown rather than empty", () => {
		// null is what a guild whose voice state has not arrived reports. If
		// that counted as empty the bot would disconnect itself on startup.
		expect(
			planLeave(
				state({ listeners: null, busy: true, aloneSince: null }),
				limits,
				now,
			),
		).toEqual({ action: "wait", idleSince: null, aloneSince: null });
	});

	test("never leaves for being alone when the limit is negative", () => {
		expect(
			planLeave(
				state({ listeners: 0, busy: true, aloneSince: now - 10 * 60 * 1000 }),
				{ ...limits, aloneMs: -1 },
				now,
			),
		).toEqual({
			action: "wait",
			idleSince: null,
			aloneSince: now - 10 * 60 * 1000,
		});
	});

	test("prefers 'alone' when both clocks are up", () => {
		expect(
			planLeave(
				state({
					listeners: 0,
					idleSince: now - limits.inactivityMs,
					aloneSince: now - limits.aloneMs,
				}),
				limits,
				now,
			),
		).toEqual({ action: "leave", reason: "alone" });
	});
});
