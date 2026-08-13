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

/** The segment covering `positionMs`, if any. */
export function segmentAt(
	segments: Segment[] | null | undefined,
	positionMs: Position,
): Segment | null {
	if (!segments || positionMs === null) return null;
	for (const segment of segments) {
		const [startInSec, endInSec] = segment.segment;
		if (positionMs >= startInSec * 1000 && positionMs <= endInSec * 1000) {
			return segment;
		}
	}
	return null;
}

/** A segment that has not been reached yet, and how long until it starts. */
export interface UpcomingSegment {
	segment: Segment;
	delayMs: number;
}

/**
 * Segments still ahead of `positionMs`, with the delay until each one.
 *
 * A segment already in progress is not included: it is not something to wait
 * for, it is something the caller should act on now via {@link segmentAt}.
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
