import ytdl from "@distube/ytdl-core";
import ytSearch from "yt-search";
import { globalApp } from "./misc";
import { fetchPlaylist, getPlaylistId, isPlaylistUrl } from "./youtubePlaylist";

export { getPlaylistId };

export interface YouTubeChannel {
	name: string;
	url: string;
}

export interface YouTubeThumbnail {
	url: string;
}

export interface YouTubeVideo {
	id: string;
	url: string;
	title: string;
	durationInSec: number;
	channel: YouTubeChannel;
	thumbnails: YouTubeThumbnail[];
}

export interface YouTubePlaylist {
	url: string;
	title: string;
	videos: YouTubeVideo[];
}

export interface YouTubeVideoInfo {
	video_details: YouTubeVideo;
}

const WATCH_URL = "https://www.youtube.com/watch?v=";

function normalizeVideo(video: {
	videoId: string;
	title: string;
	seconds?: number;
	duration?: { seconds?: number };
	author?: { name?: string; url?: string };
	thumbnail?: string;
	image?: string;
}): YouTubeVideo {
	const id = video.videoId;
	const channelName = video.author?.name ?? "";
	return {
		id,
		url: `${WATCH_URL}${id}`,
		title: video.title,
		durationInSec: video.seconds ?? video.duration?.seconds ?? 0,
		channel: {
			name: channelName,
			url: video.author?.url ?? "",
		},
		thumbnails: [video.thumbnail ?? video.image]
			.filter((url): url is string => Boolean(url))
			.map(url => ({ url })),
	};
}

export function getYouTubeVideoId(url: string): string | null {
	try {
		return ytdl.getVideoID(url);
	} catch {
		return null;
	}
}

export function isYouTubeVideo(url: string): boolean {
	return ytdl.validateURL(url);
}

export function isYouTubePlaylist(url: string): boolean {
	return isPlaylistUrl(url);
}

export function isYouTubeUrl(url: string): boolean {
	return isYouTubeVideo(url) || isYouTubePlaylist(url);
}

export async function searchYouTube(query: string): Promise<YouTubeVideo[]> {
	try {
		const result = await ytSearch(query);
		// A malformed entry should cost one row, not the whole search
		return result.videos
			.filter((video) => video && typeof video.title === "string")
			.map(normalizeVideo);
	} catch (error) {
		// yt-search throws while parsing some result pages, where a non-string
		// title reaches .trim() inside its own parser and so cannot be guarded
		// against beforehand. The dashboard searches on every keystroke, so one
		// bad page must not take the request down with it.
		globalApp.err(
			`YouTube search failed for "${query}": ${(error as Error).message}`,
		);
		return [];
	}
}

export async function getYouTubePlaylist(
	url: string,
): Promise<YouTubePlaylist> {
	return await fetchPlaylist(url);
}

export async function getYouTubeVideoInfo(
	url: string,
	agent?: ytdl.Agent,
): Promise<YouTubeVideoInfo> {
	// getBasicInfo only reads videoDetails. getInfo additionally deciphers the
	// stream formats, which breaks ("Failed to find any playable formats")
	// whenever YouTube ships a player script ytdl-core cannot parse - and the
	// formats are unused here anyway
	const info = await ytdl.getBasicInfo(url, { agent });
	const details = info.videoDetails;
	const channelId = details.author?.id ?? details.channelId;
	return {
		video_details: {
			id: details.videoId,
			url: `${WATCH_URL}${details.videoId}`,
			title: details.title,
			durationInSec: Number(details.lengthSeconds),
			channel: {
				name: details.author?.name ?? "",
				url:
					details.author?.channel_url ??
					(channelId
						? `https://www.youtube.com/channel/${channelId}`
						: ""),
			},
			thumbnails: (details.thumbnails ?? []).map(thumbnail => ({
				url: thumbnail.url,
			})),
		},
	};
}
