/**
 * When a scheduled play warns, when it cuts in, and how a typed time is read.
 *
 * Kept free of `CustomAudioPlayer` for the same reason as `leavePlan.ts`: that
 * class reaches @distube/ytdl-core through its imports, which does not load
 * under Bun, and these are the parts worth testing directly.
 */

/** How long before a cut-in the channel is asked whether to let it happen. */
export const WARNING_MS = 10_000;

/**
 * The longest delay `setTimeout` honours. Anything past it fires immediately,
 * and a premiere can easily be announced a month out, so a timer that long is
 * armed in hops instead.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export type TimerPlan =
	| { action: "wait"; delayMs: number }
	| { action: "warn"; delayMs: number }
	| { action: "fire"; delayMs: number };

/**
 * The cut-in never lands sooner than WARNING_MS after the warning went out.
 *
 * Without this, something scheduled three seconds out — or a warning that was
 * slow to send — would give the channel three seconds to react to a ten-second
 * notice. Starting a premiere a few seconds late is the cheaper mistake.
 */
export function fireTime(at: number, warnedAt: number | null): number {
	return warnedAt === null ? at : Math.max(at, warnedAt + WARNING_MS);
}

/** The next timer to arm for an entry, given whether it has warned yet. */
export function planTimer(
	at: number,
	warnedAt: number | null,
	now: number,
): TimerPlan {
	if (warnedAt === null) {
		const untilWarn = at - WARNING_MS - now;
		if (untilWarn > MAX_TIMER_MS) {
			return { action: "wait", delayMs: MAX_TIMER_MS };
		}
		// Already inside the window — scheduled close, or a late wake — so the
		// warning goes now and fireTime() pushes the cut-in back to fit it.
		return { action: "warn", delayMs: Math.max(0, untilWarn) };
	}
	const untilFire = fireTime(at, warnedAt) - now;
	return { action: "fire", delayMs: Math.max(0, untilFire) };
}

const UNIT_MS: Record<string, number> = {
	h: 60 * 60 * 1000,
	m: 60 * 1000,
	s: 1000,
};

/**
 * A typed time as epoch milliseconds, or null when it cannot be read.
 *
 * Accepted, in the order they are tried:
 *   - a Discord timestamp, `<t:1792643400>` or `<t:1792643400:F>`, which is
 *     what someone pastes after generating one for their own timezone;
 *   - a unix time, in seconds (10 digits) or milliseconds (13);
 *   - a relative duration, `90s`, `10m`, `1h30m`, optionally after "in";
 *   - a bare number of minutes;
 *   - a clock time, `21:30` or `21:30:15`, taken as the next time the bot's
 *     clock reads that;
 *   - anything with a date that `Date.parse` understands, `2026-10-22 21:30`.
 *
 * Clock and date times are read in the bot's timezone. Callers echo the result
 * back as a Discord timestamp, which every reader sees in their own, so a
 * wrong guess is visible rather than silent.
 */
export function parseScheduleTime(input: string, now: number): number | null {
	const text = input.trim().toLowerCase();
	if (!text) return null;

	const discord = /^<t:(\d+)(?::[a-z])?>$/i.exec(text);
	if (discord) return Number(discord[1]) * 1000;

	if (/^\d{10}$/.test(text)) return Number(text) * 1000;
	if (/^\d{13}$/.test(text)) return Number(text);

	const relative = text.replace(/^in\s+/, "").replace(/\s+/g, "");
	if (/^(\d+[hms])+$/.test(relative)) {
		let total = 0;
		for (const [, amount, unit] of relative.matchAll(/(\d+)([hms])/g)) {
			total += Number(amount) * UNIT_MS[unit];
		}
		return now + total;
	}
	if (/^\d{1,4}$/.test(relative)) return now + Number(relative) * UNIT_MS.m;

	const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
	if (clock) {
		const [hours, minutes, seconds] = [clock[1], clock[2], clock[3] ?? "0"].map(Number);
		if (hours > 23 || minutes > 59 || seconds > 59) return null;
		const target = new Date(now);
		target.setHours(hours, minutes, seconds, 0);
		// A time already gone today means tomorrow's
		if (target.getTime() <= now) target.setDate(target.getDate() + 1);
		return target.getTime();
	}

	// "2026-10-22 21:30" is not ISO until the space is a T; without the T some
	// engines read it as UTC and others as local time.
	const parsed = Date.parse(input.trim().replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T"));
	return Number.isNaN(parsed) ? null : parsed;
}
