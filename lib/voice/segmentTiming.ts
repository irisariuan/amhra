import type { Segment } from "./segment";

/**
 * Deciding which SponsorBlock segment applies at a given moment.
 *
 * Pulled out of `CustomAudioPlayer` so it can be tested without a voice
 * connection. The player's copies of these checks both treated position zero as
 * "no position" — a falsy-number bug — which is precisely the position a track
 * has when it starts, so segments were never scheduled for a newly switched
 * track and a segment at 0:00 was never detected.
 */

/** Milliseconds into the track, or `null` when nothing is playing. */
export type Position = number | null;

/**
 * The segment covering `positionMs`, if any.
 *
 * Both ends count as inside, so two segments that touch — one ending where the
 * next begins — both cover that instant. The later one wins: it is the part
 * still ahead of the listener, while the earlier one is over. Taking the
 * earlier one is what made a skip land on its own end and stay there, because
 * the caller seeks to `segment[1]` and then asks this again.
 */
export function segmentAt(
	segments: Segment[] | null | undefined,
	positionMs: Position,
): Segment | null {
	if (!segments || positionMs === null) return null;
	let found: Segment | null = null;
	for (const segment of segments) {
		const [startInSec, endInSec] = segment.segment;
		if (positionMs < startInSec * 1000 || positionMs > endInSec * 1000) {
			continue;
		}
		if (!found || startInSec > found.segment[0]) found = segment;
	}
	return found;
}

/** A segment that has not been reached yet, and how long until it starts. */
export interface UpcomingSegment {
	segment: Segment;
	delayMs: number;
}

/**
 * Segments not yet started at `positionMs`, with the delay until each one.
 *
 * A segment already under way is left out: it is not something to wait for, it
 * is something the caller should act on now via {@link segmentAt}. One
 * starting at exactly this position is not yet under way, so it is included
 * with a delay of zero — that is the case a track opening with a non-music
 * intro hits, checked at the instant it starts, and dropping it is how those
 * went undetected before.
 */
export function upcomingSegments(
	segments: Segment[] | null | undefined,
	positionMs: Position,
): UpcomingSegment[] {
	if (!segments || positionMs === null) return [];
	const upcoming: UpcomingSegment[] = [];
	for (const segment of segments) {
		const startMs = segment.segment[0] * 1000;
		if (startMs < positionMs) continue;
		upcoming.push({ segment, delayMs: startMs - positionMs });
	}
	return upcoming;
}
