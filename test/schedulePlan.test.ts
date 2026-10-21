import { describe, expect, test } from "bun:test";
import {
	fireTime,
	MAX_TIMER_MS,
	parseScheduleTime,
	planTimer,
	WARNING_MS,
} from "../lib/voice/schedulePlan";

/**
 * When a scheduled play warns and cuts in, and how a typed time is read.
 */

const now = new Date(2026, 9, 21, 12, 0, 0).getTime();

describe("timers", () => {
	test("warns WARNING_MS before the time", () => {
		expect(planTimer(now + 60_000, null, now)).toEqual({
			action: "warn",
			delayMs: 60_000 - WARNING_MS,
		});
	});

	test("cuts in at the time once warned", () => {
		const warnedAt = now + 60_000 - WARNING_MS;
		expect(planTimer(now + 60_000, warnedAt, warnedAt)).toEqual({
			action: "fire",
			delayMs: WARNING_MS,
		});
	});

	test("warns at once when scheduled inside the window", () => {
		expect(planTimer(now + 3_000, null, now)).toEqual({ action: "warn", delayMs: 0 });
	});

	test("always leaves the full warning before cutting in", () => {
		// Scheduled 3s out and warned straight away: the channel still gets
		// ten seconds, not three.
		expect(fireTime(now + 3_000, now)).toBe(now + WARNING_MS);
		expect(planTimer(now + 3_000, now, now)).toEqual({
			action: "fire",
			delayMs: WARNING_MS,
		});
	});

	test("a late warning pushes the cut-in back", () => {
		expect(fireTime(now, now + 2_000)).toBe(now + 2_000 + WARNING_MS);
	});

	test("hops rather than overflowing setTimeout for far-off premieres", () => {
		const month = 30 * 24 * 60 * 60 * 1000;
		expect(planTimer(now + month, null, now)).toEqual({
			action: "wait",
			delayMs: MAX_TIMER_MS,
		});
	});

	test("fires immediately when the time is long gone", () => {
		expect(planTimer(now - 60_000, now - 70_000, now)).toEqual({
			action: "fire",
			delayMs: 0,
		});
	});
});

describe("parseScheduleTime", () => {
	test("relative durations", () => {
		expect(parseScheduleTime("90s", now)).toBe(now + 90_000);
		expect(parseScheduleTime("10m", now)).toBe(now + 600_000);
		expect(parseScheduleTime("1h30m", now)).toBe(now + 90 * 60_000);
		expect(parseScheduleTime("in 1h 5m", now)).toBe(now + 65 * 60_000);
	});

	test("a bare number is minutes", () => {
		expect(parseScheduleTime("15", now)).toBe(now + 15 * 60_000);
	});

	test("Discord timestamps and unix times", () => {
		expect(parseScheduleTime("<t:1792643400:F>", now)).toBe(1792643400_000);
		expect(parseScheduleTime("<t:1792643400>", now)).toBe(1792643400_000);
		expect(parseScheduleTime("1792643400", now)).toBe(1792643400_000);
		expect(parseScheduleTime("1792643400123", now)).toBe(1792643400123);
	});

	test("a clock time later today", () => {
		expect(parseScheduleTime("21:30", now)).toBe(
			new Date(2026, 9, 21, 21, 30, 0).getTime(),
		);
	});

	test("a clock time already gone means tomorrow", () => {
		expect(parseScheduleTime("08:15:30", now)).toBe(
			new Date(2026, 9, 22, 8, 15, 30).getTime(),
		);
	});

	test("a date and time, with a space or a T", () => {
		const expected = new Date(2026, 9, 22, 21, 30, 0).getTime();
		expect(parseScheduleTime("2026-10-22 21:30", now)).toBe(expected);
		expect(parseScheduleTime("2026-10-22T21:30", now)).toBe(expected);
	});

	test("refuses what it cannot read", () => {
		expect(parseScheduleTime("", now)).toBeNull();
		expect(parseScheduleTime("soon", now)).toBeNull();
		expect(parseScheduleTime("25:00", now)).toBeNull();
		expect(parseScheduleTime("10x", now)).toBeNull();
	});
});
