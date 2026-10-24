/**
 * The rules every queue in a guild follows between its songs, kept free of
 * imports like `nativePlan.ts` so they are testable without the player.
 *
 * A guild has up to `MAX_QUEUES` queues. Queue 1 is the one `/play` has
 * always filled; the others are mixed in over it by the sidecar, each a full
 * player of its own. Any of them can leave a gap between songs, and any song
 * can carry a lead-in of its own, set by where it was dropped on the
 * dashboard's timeline. Nothing here sets a timer: a waiting queue records
 * when it started waiting and why, and when its next song is due follows from
 * that, so pausing, reordering and changing a gap stay a matter of arithmetic.
 */

/** Queues one guild may have, kept in step with MAX_QUEUES in rust/amhra-voice/src/mixer.rs. */
export const MAX_QUEUES = 9;
/** Songs a mixed-in queue may have waiting, so a stuck bot cannot pile up thousands. */
export const MAX_QUEUE_LENGTH = 100;
/** The longest silence a queue may leave between two songs. */
export const MAX_GAP_MS = 10 * 60_000;
/**
 * The longest silence before one song, set by where it was dropped on the
 * editor's timeline. Far more than a queue's gap: lining a song up after a
 * long queue on another lane can put it an hour or more out.
 */
export const MAX_LEAD_IN_MS = 6 * 60 * 60_000;

/**
 * A wait for a queue's next song, counted from `from`: after a song ended it
 * is the song's lead-in, or the queue's gap; on a silent queue it is the
 * song's own lead-in or none; after a skip it is none at all.
 */
export interface QueueWait {
	from: number;
	after: "song" | "silence" | "skip";
}

/** What decides how long a queue waits before a song. */
export interface Waited {
	/** Silence before it in place of the queue's gap. */
	gapBeforeMs?: number;
}

/** How long to wait before `next`, after whatever `after` says came before it. */
export function gapBefore(after: QueueWait["after"], gapMs: number, next: Waited | undefined) {
	if (!next || after === "skip") return 0;
	return next.gapBeforeMs ?? (after === "song" ? gapMs : 0);
}

/** When a waiting queue's next song is due, or null when it has nothing to wait for. */
export function dueAt(wait: QueueWait | null, gapMs: number, next: Waited | undefined) {
	if (!wait || !next) return null;
	return wait.from + gapBefore(wait.after, gapMs, next);
}

/**
 * How long until that song, frozen at `pausedAt` while the queue is paused,
 * so the countdown a listener sees stops with the music.
 */
export function dueIn(
	wait: QueueWait | null,
	gapMs: number,
	next: Waited | undefined,
	now: number,
	pausedAt: number | null,
) {
	const due = dueAt(wait, gapMs, next);
	if (due === null) return null;
	return Math.max(0, due - (pausedAt ?? now));
}

/** The lowest queue number above 1 not in `used`, or null when the guild has them all. */
export function freeQueueNumber(used: Iterable<number>) {
	const taken = new Set(used);
	for (let n = 2; n <= MAX_QUEUES; n++) if (!taken.has(n)) return n;
	return null;
}

/** A gap as a queue allows it: whole milliseconds, from none to `MAX_GAP_MS`. */
export function clampGap(gapMs: number, max = MAX_GAP_MS) {
	return Number.isFinite(gapMs) ? Math.min(Math.max(0, Math.round(gapMs)), max) : 0;
}

/** A song's own lead-in as a queue allows it, up to `MAX_LEAD_IN_MS`. */
export function clampLeadIn(gapMs: number) {
	return clampGap(gapMs, MAX_LEAD_IN_MS);
}

/** A user's percent as the sidecar's linear gain. */
export function gainFromPercent(volume: number) {
	return Math.max(0, volume) / 100;
}
