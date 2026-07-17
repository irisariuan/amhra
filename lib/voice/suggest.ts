import { getYouTubeVideoInfo, searchYouTube } from "../youtube";
import { globalApp } from "../misc";

export interface Suggestion {
	url: string;
	title: string;
	durationInSec: number;
	channel?: string;
}

/**
 * Finds tracks for a seed video using YouTube search, excluding recently played
 * URLs. This is intentionally best-effort because suggestions are optional.
 */
export async function getSuggestions(
	seedUrl: string,
	exclude: string[] = [],
	limit = 10,
): Promise<Suggestion[]> {
	try {
		const info = await getYouTubeVideoInfo(seedUrl);
		const seed = info.video_details;
		const excluded = new Set(exclude);
		const results = await searchYouTube(`${seed.title} ${seed.channel.name}`);
		return results
			.filter(video => !excluded.has(video.url) && video.id !== seed.id)
			.slice(0, limit)
			.map(video => ({
				url: video.url,
				title: video.title,
				durationInSec: video.durationInSec,
				channel: video.channel.name || undefined,
			}));
	} catch (err) {
		globalApp.warn(`Failed to fetch suggestions: ${err}`);
		return [];
	}
}

/**
 * Picks a single suggested track to auto-append when the queue empties.
 */
export async function pickRadioTrack(
	seedUrl: string,
	exclude: string[] = [],
): Promise<string | null> {
	const suggestions = await getSuggestions(seedUrl, exclude, 5);
	return suggestions[0]?.url ?? null;
}
