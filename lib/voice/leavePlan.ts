/**
 * When the bot should take itself out of a voice channel.
 *
 * This replaces a set of one-shot `setTimeout`s that were armed and cleared
 * from five places in the playback path. That arrangement had no single place
 * where "should we still be here?" was answered, and it went wrong in the ways
 * you would expect of state spread that thin:
 *
 *   - starting a track cleared the pending timer, and pausing armed nothing, so
 *     a paused bot sat in the channel forever;
 *   - the end-of-queue path armed the timer twice, and both copies fired;
 *   - a timer that fired while something was playing returned without arming
 *     another, so the only thing that ever re-armed one was the next track
 *     ending.
 *
 * So the decision is a function of the player's current state instead, re-asked
 * on a sweep. Nothing to arm, nothing to clear, and no way for the bot to end
 * up with no timer at all — the two timestamps below are carried between
 * sweeps, and a state that stops being idle simply drops them.
 *
 * Kept free of `CustomAudioPlayer` so it can be tested directly: that class
 * reaches @distube/ytdl-core through its imports, which does not load under
 * Bun.
 */

export interface LeaveState {
	/**
	 * Audio is actually going out right now. A paused player is not busy —
	 * that is the whole point of counting pause as idle.
	 */
	busy: boolean;
	/**
	 * Humans in the bot's voice channel, or null when that cannot be read
	 * because the bot is not in one or its voice state has not arrived yet.
	 * Null is "unknown", never "empty".
	 */
	listeners: number | null;
	/** When the player was first seen idle. Carried between sweeps. */
	idleSince: number | null;
	/** When the bot was first seen alone. Carried between sweeps. */
	aloneSince: number | null;
	/**
	 * Something is scheduled to cut in here. The bot stays for it however long
	 * it sits idle or alone — leaving would clear the schedule with it.
	 */
	scheduled?: boolean;
}

export interface LeaveLimits {
	/**
	 * How long the player may sit idle. Negative disables leaving for
	 * inactivity; zero leaves on the first sweep that sees it idle.
	 */
	inactivityMs: number;
	/** The same, for how long the bot may sit in a channel with nobody in it. */
	aloneMs: number;
}

export type LeaveReason = "inactivity" | "alone";

export type LeavePlan =
	| { action: "leave"; reason: LeaveReason }
	| { action: "wait"; idleSince: number | null; aloneSince: number | null };

export function planLeave(
	state: LeaveState,
	limits: LeaveLimits,
	now: number,
): LeavePlan {
	// Both clocks start over rather than pausing: the wait for a premiere says
	// nothing about how long the channel has been quiet once it has played.
	if (state.scheduled) return { action: "wait", idleSince: null, aloneSince: null };
	const idleSince = state.busy ? null : (state.idleSince ?? now);
	// Only a channel we can see into and that has nobody in it starts this
	// clock. Treating an unreadable channel as empty would disconnect the bot
	// every time a voice state was slow to arrive.
	const aloneSince =
		state.listeners === 0 ? (state.aloneSince ?? now) : null;

	// Being alone is checked first because it is the more specific answer: a
	// bot by itself is usually idle too, and "everyone left" is the more
	// useful of the two to find in a log.
	if (
		limits.aloneMs >= 0 &&
		aloneSince !== null &&
		now - aloneSince >= limits.aloneMs
	) {
		return { action: "leave", reason: "alone" };
	}
	if (
		limits.inactivityMs >= 0 &&
		idleSince !== null &&
		now - idleSince >= limits.inactivityMs
	) {
		return { action: "leave", reason: "inactivity" };
	}
	return { action: "wait", idleSince, aloneSince };
}
