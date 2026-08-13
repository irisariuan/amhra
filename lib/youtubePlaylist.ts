//! Playlist listing over YouTube's InnerTube `browse` endpoint.
//!
//! yt-search reads playlists out of the watch page's `playlistVideoListRenderer`,
//! which YouTube's web client no longer emits — the entries come back as
//! `lockupViewModel` instead, so its parser throws on every playlist and nothing
//! could be queued from one. Asking InnerTube directly avoids the scrape: it is
//! the same call the site makes, it pages 100 entries at a time, and the
//! response shape is the one the Rust fetcher already talks to.
//!
//! Kept apart from `youtube.ts` because that module pulls in ytdl-core at import
//! time; nothing here needs it, and the separation keeps this unit testable on
//! its own.

import { globalApp } from "./misc";

const BROWSE_ENDPOINT = "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false";
const WATCH_URL = "https://www.youtube.com/watch?v=";

/**
 * The web client returns 100 entries a page in the current `lockupViewModel`
 * shape. iOS still answers with the classic `playlistVideoRenderer`, 20 a page,
 * and stands by for the day the web shape changes again.
 */
const CLIENTS = [
	{
		clientName: "WEB",
		clientVersion: "2.20250120.00.00",
		hl: "en",
		gl: "US",
	},
	{
		clientName: "IOS",
		clientVersion: "20.03.02",
		deviceMake: "Apple",
		deviceModel: "iPhone16,2",
		hl: "en",
		gl: "US",
	},
] as const;

/** Runaway guard: 100 pages of the web client is 10k entries. */
const MAX_PAGES = 100;

export interface PlaylistVideo {
	id: string;
	url: string;
	title: string;
	durationInSec: number;
	channel: { name: string; url: string };
	thumbnails: { url: string }[];
}

export interface PlaylistListing {
	url: string;
	title: string;
	videos: PlaylistVideo[];
}

const YOUTUBE_HOSTS = new Set([
	"youtube.com",
	"www.youtube.com",
	"m.youtube.com",
	"music.youtube.com",
	"youtu.be",
	"www.youtu.be",
]);

/**
 * The `list` id of a playlist URL, or null.
 *
 * A watch link carrying `list=` counts: that is what the share button hands out
 * while a playlist is open, and dropping the parameter would quietly queue one
 * song where the user asked for the set.
 *
 * Mixes (`RD…`) and the personal queues (`LL`, `WL`) are refused. They are
 * generated per session rather than stored, so `browse` has nothing to return
 * for them — a mix link still plays as the plain video it points at.
 */
export function getPlaylistId(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (!YOUTUBE_HOSTS.has(parsed.hostname)) return null;
	const listId = parsed.searchParams.get("list");
	if (!listId) return null;
	if (/^(RD|UL|LL|WL)/.test(listId)) return null;
	return listId;
}

export function isPlaylistUrl(url: string): boolean {
	return getPlaylistId(url) !== null;
}

export function playlistUrlOf(listId: string): string {
	return `https://www.youtube.com/playlist?list=${listId}`;
}

/** Collect every value stored under `key`, at any depth. */
function collect(node: unknown, key: string, out: unknown[] = []): unknown[] {
	if (!node || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const item of node) collect(item, key, out);
		return out;
	}
	for (const [k, value] of Object.entries(node)) {
		if (k === key) out.push(value);
		collect(value, key, out);
	}
	return out;
}

type Json = Record<string, any>;

/** "3:55" or "1:02:03" as seconds. */
function parseDuration(text: string | undefined): number {
	if (!text) return 0;
	const parts = text.split(":").map((part) => Number.parseInt(part, 10));
	if (parts.some((part) => Number.isNaN(part))) return 0;
	return parts.reduce((total, part) => total * 60 + part, 0);
}

function videoOf(
	id: string,
	title: string,
	durationInSec: number,
	channelName: string,
	channelId: string | undefined,
	thumbnails: string[],
): PlaylistVideo {
	return {
		id,
		url: `${WATCH_URL}${id}`,
		title,
		durationInSec,
		channel: {
			name: channelName,
			url: channelId ? `https://www.youtube.com/channel/${channelId}` : "",
		},
		thumbnails: thumbnails.map((url) => ({ url })),
	};
}

/** Current web shape. */
function parseLockup(lockup: Json): PlaylistVideo | null {
	if (lockup?.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") return null;
	const id = lockup.contentId;
	if (typeof id !== "string" || !id) return null;

	const metadata = lockup.metadata?.lockupMetadataViewModel;
	const title = metadata?.title?.content;
	if (typeof title !== "string") return null;

	const rows =
		metadata?.metadata?.contentMetadataViewModel?.metadataRows ?? [];
	const channelName = rows[0]?.metadataParts?.[0]?.text?.content ?? "";
	const channelId = (collect(rows[0], "browseEndpoint")[0] as Json | undefined)
		?.browseId;

	// The runtime badge under the thumbnail is the only duration the web shape
	// carries, and a live or upcoming entry has none — 0 reads as "unknown"
	// everywhere durations are shown.
	const badges = collect(lockup.contentImage, "thumbnailBadgeViewModel") as Json[];
	const durationText = badges
		.map((badge) => badge?.text)
		.find((text): text is string => /^\d+(:\d\d)+$/.test(text ?? ""));

	const sources: Json[] =
		lockup.contentImage?.thumbnailViewModel?.image?.sources ?? [];

	return videoOf(
		id,
		title,
		parseDuration(durationText),
		channelName,
		typeof channelId === "string" ? channelId : undefined,
		sources
			.map((source) => source?.url)
			.filter((url): url is string => typeof url === "string"),
	);
}

/** Classic shape, still served to the iOS client. */
function parseClassic(renderer: Json): PlaylistVideo | null {
	const id = renderer?.videoId;
	if (typeof id !== "string" || !id) return null;
	const title =
		renderer.title?.runs?.[0]?.text ?? renderer.title?.simpleText ?? "";
	const byline = renderer.shortBylineText?.runs?.[0];
	const durationInSec =
		Number.parseInt(renderer.lengthSeconds ?? "", 10) ||
		parseDuration(renderer.lengthText?.runs?.[0]?.text);
	const thumbnails: Json[] = renderer.thumbnail?.thumbnails ?? [];
	return videoOf(
		id,
		title,
		durationInSec,
		byline?.text ?? "",
		byline?.navigationEndpoint?.browseEndpoint?.browseId,
		thumbnails
			.map((thumbnail) => thumbnail?.url)
			.filter((url): url is string => typeof url === "string"),
	);
}

function parsePage(response: Json): {
	videos: PlaylistVideo[];
	continuation: string | null;
} {
	const videos = [
		...(collect(response, "lockupViewModel") as Json[]).map(parseLockup),
		...(collect(response, "playlistVideoRenderer") as Json[]).map(parseClassic),
	].filter((video): video is PlaylistVideo => video !== null);

	const web = (collect(response, "continuationItemRenderer")[0] as Json | undefined)
		?.continuationEndpoint?.continuationCommand?.token;
	const legacy = (collect(response, "nextContinuationData")[0] as Json | undefined)
		?.continuation;

	return {
		videos,
		continuation:
			(typeof web === "string" && web) ||
			(typeof legacy === "string" && legacy) ||
			null,
	};
}

function titleOf(response: Json): string {
	const metadata = collect(response, "playlistMetadataRenderer")[0] as
		| Json
		| undefined;
	const header = collect(response, "playlistHeaderRenderer")[0] as
		| Json
		| undefined;
	return (
		metadata?.title ??
		header?.title?.simpleText ??
		header?.title?.runs?.[0]?.text ??
		"Playlist"
	);
}

async function browse(
	client: (typeof CLIENTS)[number],
	body: Json,
): Promise<Json | null> {
	try {
		const response = await fetch(BROWSE_ENDPOINT, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"user-agent":
					client.clientName === "IOS"
						? `com.google.ios.youtube/${client.clientVersion} (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X;)`
						: "Mozilla/5.0",
			},
			body: JSON.stringify({ context: { client }, ...body }),
		});
		if (!response.ok) return null;
		return (await response.json()) as Json;
	} catch (error) {
		globalApp.err(
			`InnerTube browse failed (${client.clientName}): ${(error as Error).message}`,
		);
		return null;
	}
}

/**
 * Every video of a playlist, following continuations to the end.
 *
 * Throws when the playlist cannot be read at all — a wrong link, a private
 * playlist, or both clients failing — so callers can tell that apart from a
 * playlist that is genuinely empty.
 */
export async function fetchPlaylist(url: string): Promise<PlaylistListing> {
	const listId = getPlaylistId(url);
	if (!listId) throw new Error(`Not a YouTube playlist URL: ${url}`);

	for (const client of CLIENTS) {
		const first = await browse(client, { browseId: `VL${listId}` });
		if (!first) continue;

		const page = parsePage(first);
		if (!page.videos.length) continue;

		const videos = [...page.videos];
		const seen = new Set(videos.map((video) => video.id));
		let continuation = page.continuation;

		for (let pages = 1; continuation && pages < MAX_PAGES; pages++) {
			const next = await browse(client, { continuation });
			if (!next) break;
			const parsed = parsePage(next);
			if (!parsed.videos.length) break;
			// A continuation token that returns the page it came from would spin
			// until MAX_PAGES; de-duplicating by id ends it at the first repeat.
			const fresh = parsed.videos.filter((video) => !seen.has(video.id));
			if (!fresh.length) break;
			for (const video of fresh) seen.add(video.id);
			videos.push(...fresh);
			continuation = parsed.continuation;
		}

		return { url: playlistUrlOf(listId), title: titleOf(first), videos };
	}

	throw new Error(`Could not read playlist ${listId}`);
}
