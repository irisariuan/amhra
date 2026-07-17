import { video_info, yt_validate } from "play-dl";
import { globalApp } from "../misc";

export interface Suggestion {
	url: string;
	title: string;
	durationInSec: number;
	channel?: string;
}

const YT_WATCH = "https://www.youtube.com/watch?v=";

/**
 * Related-track suggestions for a seed video, drawn from YouTube's own related
 * list, excluding anything already in `exclude` (history/queue). Ordered by
 * YouTube's relevance; capped at `limit`.
 */
export async function getSuggestions(
	seedUrl: string,
	exclude: string[] = [],
	limit = 10,
): Promise<Suggestion[]> {
	if (yt_validate(seedUrl) !== "video") return [];
	try {
		const info = await video_info(seedUrl);
		const excluded = new Set(exclude);
		const related = info.related_videos ?? [];
		const suggestions: Suggestion[] = [];
		for (const id of related) {
			const url = id.startsWith("http") ? id : `${YT_WATCH}${id}`;
			if (excluded.has(url)) continue;
			try {
				const detail = (await video_info(url)).video_details;
				if (!detail?.title) continue;
				suggestions.push({
					url,
					title: detail.title,
					durationInSec: detail.durationInSec,
					channel: detail.channel?.name ?? undefined,
				});
			} catch {
				// Skip individual videos that fail to resolve.
			}
			if (suggestions.length >= limit) break;
		}
		return suggestions;
	} catch (err) {
		globalApp.warn(`Failed to fetch suggestions: ${err}`);
		return [];
	}
}

/**
 * Picks a single related track to auto-append when the queue empties (radio
 * mode), avoiding recently played songs. Returns null if none is available.
 */
export async function pickRadioTrack(
	seedUrl: string,
	exclude: string[] = [],
): Promise<string | null> {
	const suggestions = await getSuggestions(seedUrl, exclude, 5);
	return suggestions[0]?.url ?? null;
}
