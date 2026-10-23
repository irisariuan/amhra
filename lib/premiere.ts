//! Upcoming premieres and scheduled livestreams, and when they start.
//!
//! A premiere cannot be played until it begins, so ytdl-core's `getInfo`
//! refuses it, with the code `NOT_STARTED` and, when the offline slate gives
//! one, the start time. That refusal is what says a video is a premiere
//! ([`upcomingFrom`]): any other refusal (private, removed, region-blocked)
//! is not one, and costs no further request.
//!
//! The refusal carries no title, which the schedule shows, so a premiere is
//! then looked up with InnerTube's `player` endpoint, which answers anyway:
//! the title, the channel, and the start time again, with a second place to
//! find it. If that lookup fails, ytdl-core's start time is enough to
//! schedule it by its link.
//!
//! Kept apart from `youtube.ts` for the same reason as the playlist module:
//! nothing here reads the bot's settings at import time, so this can be
//! tested on its own.

import { YtdlError } from "@distube/ytdl-core";
import { innertube, WEB_CLIENT } from "./youtubePlaylist";

const WATCH_URL = "https://www.youtube.com/watch?v=";

export interface Upcoming {
	videoId: string;
	url: string;
	title: string;
	channel: string;
	/** When it is due to start, epoch milliseconds */
	startsAt: number;
}

type Json = Record<string, any>;

/**
 * The upcoming premiere a `player` response describes, or null if it is not one.
 *
 * Two places carry the start time. The offline slate's `scheduledStartTime`
 * (unix seconds) is what the watch page counts down to; the microformat's
 * `liveBroadcastDetails.startTimestamp` (ISO) is the fallback, since the slate
 * is a rendering detail and has moved before.
 */
export function parseUpcoming(response: Json | null): Upcoming | null {
	if (!response) return null;
	const details = response.videoDetails ?? {};
	const playability = response.playabilityStatus ?? {};
	const upcoming =
		details.isUpcoming === true || playability.status === "LIVE_STREAM_OFFLINE";
	if (!upcoming || typeof details.videoId !== "string") return null;

	const slate =
		playability.liveStreamability?.liveStreamabilityRenderer?.offlineSlate
			?.liveStreamOfflineSlateRenderer?.scheduledStartTime;
	const broadcast =
		response.microformat?.playerMicroformatRenderer?.liveBroadcastDetails
			?.startTimestamp;

	let startsAt = Number.NaN;
	if (typeof slate === "string" && /^\d+$/.test(slate)) {
		startsAt = Number(slate) * 1000;
	} else if (typeof broadcast === "string") {
		startsAt = Date.parse(broadcast);
	}
	if (Number.isNaN(startsAt)) return null;

	return {
		videoId: details.videoId,
		url: `${WATCH_URL}${details.videoId}`,
		title: typeof details.title === "string" ? details.title : details.videoId,
		channel: typeof details.author === "string" ? details.author : "",
		startsAt,
	};
}

/** The premiere a video id points at, or null if it is not an upcoming one. */
export async function getUpcoming(videoId: string): Promise<Upcoming | null> {
	return parseUpcoming(await innertube("player", WEB_CLIENT, { videoId }));
}

/**
 * The premiere behind ytdl-core's refusal to look `videoId` up, or null when
 * it refused for any other reason, or for a premiere with no start time to
 * be found.
 */
export async function upcomingFrom(error: unknown, videoId: string): Promise<Upcoming | null> {
	if (!YtdlError.is(error, "NOT_STARTED")) return null;
	const found = await getUpcoming(videoId).catch(() => null);
	if (found) return found;
	const startsAt = error.startTime?.getTime();
	if (startsAt === undefined || Number.isNaN(startsAt)) return null;
	const url = `${WATCH_URL}${videoId}`;
	return { videoId, url, title: url, channel: "", startsAt };
}
