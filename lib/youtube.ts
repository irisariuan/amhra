import { parseVideoId, Ytdl } from "@distube/ytdl-core";
import fs from "node:fs";
import ytSearch from "yt-search";
import { globalApp } from "./misc";
import { readSetting } from "./setting";
import { getPlaylistId, isPlaylistUrl, readPlaylist } from "./youtubePlaylist";

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

let client: Ytdl | undefined;

/**
 * The cookie header for data/cookies.json, or undefined without one.
 *
 * The file holds a browser export: an array of `{ name, value }` objects, as
 * v4's createAgent took. v5 wants a `Cookie` header or a Netscape export, so
 * the array is joined into a header and a string is passed through as is.
 */
function readCookie(): string | undefined {
	if (!readSetting().USE_COOKIES) return;
	try {
		const cookies: unknown = JSON.parse(
			fs.readFileSync(`${process.cwd()}/data/cookies.json`, "utf8"),
		);
		if (typeof cookies === "string") return cookies;
		if (Array.isArray(cookies)) {
			return cookies
				.filter(cookie => cookie?.name && cookie.value !== undefined)
				.map(cookie => `${cookie.name}=${cookie.value}`)
				.join("; ");
		}
	} catch {
		globalApp.warn("No cookies found");
	}
}

/** The one ytdl session, made on first use so cookies are read once. */
export function getYtdl(): Ytdl {
	client ??= new Ytdl({ cookie: readCookie() });
	return client;
}

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
	return parseVideoId(url) ?? null;
}

/**
 * Whether `url` is a link to one YouTube video.
 *
 * parseVideoId also accepts a bare 11-character ID, which v4's validateURL did
 * not. Search text such as "nevergonnag" would then be played as a video, so
 * only something that parses as a URL counts.
 */
export function isYouTubeVideo(url: string): boolean {
	if (!URL.canParse(url)) return false;
	return parseVideoId(url) !== undefined;
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
	return await readPlaylist(url);
}

export async function getYouTubeVideoInfo(
	url: string,
): Promise<YouTubeVideoInfo> {
	const info = await getYtdl().getInfo(url);
	const details = info.videoDetails;
	const channelId = details.author.id;
	return {
		video_details: {
			id: details.id,
			url: `${WATCH_URL}${details.id}`,
			title: details.title,
			durationInSec: details.lengthSeconds,
			channel: {
				name: details.author.name,
				url:
					details.author.url ||
					(channelId
						? `https://www.youtube.com/channel/${channelId}`
						: ""),
			},
			thumbnails: details.thumbnails.map(thumbnail => ({
				url: thumbnail.url,
			})),
		},
	};
}
