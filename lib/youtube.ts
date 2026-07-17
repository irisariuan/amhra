import ytdl from "@distube/ytdl-core";
import ytSearch from "yt-search";

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
	all_videos(): Promise<YouTubeVideo[]>;
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
	try {
		const parsed = new URL(url);
		return (
			(parsed.hostname === "youtube.com" ||
				parsed.hostname === "www.youtube.com" ||
				parsed.hostname === "m.youtube.com" ||
				parsed.hostname === "music.youtube.com") &&
			parsed.pathname === "/playlist" &&
			Boolean(parsed.searchParams.get("list"))
		);
	} catch {
		return false;
	}
}

export function isYouTubeUrl(url: string): boolean {
	return isYouTubeVideo(url) || isYouTubePlaylist(url);
}

export async function searchYouTube(query: string): Promise<YouTubeVideo[]> {
	const result = await ytSearch(query);
	return result.videos.map(normalizeVideo);
}

export async function getYouTubePlaylist(
	url: string,
): Promise<YouTubePlaylist> {
	const listId = new URL(url).searchParams.get("list");
	if (!listId) throw new Error("Invalid YouTube playlist URL");

	const playlist = await ytSearch({ listId });
	const videos = playlist.videos
		.filter(video => Boolean(video.videoId))
		.map(normalizeVideo);
	const playlistUrl = `https://www.youtube.com/playlist?list=${listId}`;

	return {
		url: playlistUrl,
		title: playlist.title,
		videos,
		all_videos: async () => videos,
	};
}

export async function getYouTubeVideoInfo(
	url: string,
	agent?: ytdl.Agent,
): Promise<YouTubeVideoInfo> {
	const info = await ytdl.getInfo(url, { agent });
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
