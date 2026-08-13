/**
 * The decisions the native playback path makes, without the wiring.
 *
 * Kept apart from `native.ts` so they can be tested on their own: that module
 * reaches YouTube metadata and the sidecar process through its imports, and
 * these are three small rules about strings and numbers.
 */

/** What to tell the sidecar about the track after the current one. */
export type ArmPlan =
	| { action: "arm"; trackId: string }
	| { action: "clear" }
	| { action: "none" };

/**
 * Decide whether the standby slot needs changing.
 *
 * `nextTrackId` is the cache id of the queue head, or null when the queue is
 * empty or its head is not fully downloaded yet — a partial file would play to
 * the seam and then starve, which is worse than not arming anything.
 *
 * Returning `none` for an unchanged choice matters: this runs on every
 * position report, and re-sending `setNext` would rebuild the standby reader
 * about once a second for the whole track.
 */
export function planArm(nextTrackId: string | null, armed: string | null): ArmPlan {
	if (nextTrackId === armed) return { action: "none" };
	if (!nextTrackId) return armed ? { action: "clear" } : { action: "none" };
	return { action: "arm", trackId: nextTrackId };
}

/** A track the sidecar moved to on its own, and when it did so. */
export interface Promotion {
	trackId: string;
	at: number;
}

/**
 * How long a promotion is taken at its word.
 *
 * The advance it belongs to is the work between "that track finished" and
 * "here is the next one" — a cache lookup and a SponsorBlock request, well
 * under a second. Past this, the advance did not complete (a failed fetch, an
 * error on the way) and the sidecar is no longer playing what it promoted.
 */
export const PROMOTION_GRACE_MS = 5_000;

/**
 * Whether starting this track means sending a `play`.
 *
 * When the track was armed, the sidecar promoted it the instant the previous
 * one ended — that promotion is the crossfade. The queue then advances on this
 * side as it always does, and a `play` for the track already playing would
 * restart it from zero and cut off the fade that just ran.
 *
 * A non-zero start is always sent: it means a seek or a segment skip, which is
 * a different position from the one the sidecar promoted to.
 *
 * The two ways of being wrong here are not equally bad. Sending a redundant
 * `play` costs the crossfade; suppressing a needed one is silence until the
 * user notices. So anything uncertain — a stale promotion above all — sends.
 */
export function shouldSendPlay(
	promoted: Promotion | null,
	trackId: string,
	startMs: number,
	now: number,
) {
	if (!promoted || startMs !== 0) return true;
	if (promoted.trackId !== trackId) return true;
	return now - promoted.at > PROMOTION_GRACE_MS;
}

/** The last position the sidecar reported, and when that report arrived. */
export interface PositionAnchor {
	ms: number;
	at: number;
}

/**
 * Where playback is now, given the last report.
 *
 * Reports arrive about once a second, which is far too coarse for a progress
 * bar or a segment timer, so the wall clock carries the position between them
 * and every report resets whatever drift accumulated. While paused the anchor
 * is the whole answer: no reports arrive, and time passing is not progress.
 */
export function positionFrom(
	anchor: PositionAnchor | null,
	paused: boolean,
	now: number,
) {
	if (!anchor) return null;
	if (paused) return anchor.ms;
	return anchor.ms + Math.max(0, now - anchor.at);
}
