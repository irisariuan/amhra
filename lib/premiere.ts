//! Upcoming premieres and scheduled livestreams, and when they start.
//!
//! ytdl-core's `getInfo` refuses any video whose playability is
//! `LIVE_STREAM_OFFLINE`, which is exactly the state a premiere sits in until
//! it begins. InnerTube's `player` endpoint answers anyway, with the start
//! time on the offline slate. (Since 5.0 ytdl-core's refusal carries that
//! start time too, as `NOT_STARTED`; this lookup predates it and is tested.)
//!
//! Kept apart from `youtube.ts` for the same reason as the playlist module:
//! nothing here reads the bot's settings at import time, so this can be
//! tested on its own.

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
