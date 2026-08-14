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

/**
 * Everything a player knows about the sidecar playing for it.
 *
 * These three travelled together as separate fields on the player: set
 * together, cleared together in three different places, and meaningless on a
 * player driving @discordjs/voice instead. Held as one object, a player either
 * has one — and is native — or has none, so there is no longer a way to write a
 * sidecar-only field on the path with no sidecar behind it.
 */
export class NativePlayback {
	/**
	 * The track handed to the sidecar as "what comes next", so the seam can be
	 * crossfaded. Null when nothing is armed.
	 */
	armed: string | null = null;
	/**
	 * The last position the sidecar reported, and when it arrived. Reports come
	 * about once a second, so the wall clock fills the gaps between them.
	 */
	anchor: PositionAnchor | null = null;
	/**
	 * The track the sidecar moved to by itself when the last one ended.
	 *
	 * Recorded the moment it is known rather than read off `armed` later: the
	 * queue advance is asynchronous, and a position report arriving part-way
	 * through it re-arms whatever is at the head of the queue by then.
	 */
	promoted: Promotion | null = null;

	/** Nothing playing, nothing armed, nothing promoted. */
	clear() {
		this.armed = null;
		this.anchor = null;
		this.promoted = null;
	}

	/** Pin the position to `ms` as of `now`: a report, a seek, a track start. */
	anchorAt(ms: number, now: number) {
		this.anchor = { ms, at: now };
	}

	/**
	 * Start counting from now again, at the position already anchored.
	 *
	 * What unpausing needs: time is running once more, but it has not been
	 * running since the last report, which arrived before the pause.
	 */
	resumeAt(now: number) {
		if (this.anchor) this.anchor = { ...this.anchor, at: now };
	}

	/** Where playback is now, or null when nothing has been reported yet. */
	positionAt(paused: boolean, now: number) {
		return positionFrom(this.anchor, paused, now);
	}

	/**
	 * Take the armed track as the one the sidecar has just moved to, and stop
	 * considering it armed — it is playing now, not standing by.
	 */
	promote(now: number) {
		this.promoted = this.armed ? { trackId: this.armed, at: now } : null;
		this.armed = null;
	}

	/** The promotion to weigh against a `play`, taken and forgotten in one go. */
	takePromotion() {
		const promoted = this.promoted;
		this.promoted = null;
		return promoted;
	}
}
