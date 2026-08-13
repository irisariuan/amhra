import { afterEach, describe, expect, test } from "bun:test";
import {
	fetchPlaylist,
	getPlaylistId,
	isPlaylistUrl,
} from "../lib/youtubePlaylist";

/**
 * Playlist listing over InnerTube.
 *
 * The responses are stubbed rather than fetched: what broke the previous
 * implementation was a change in the response shape, so the shapes are what is
 * worth pinning down — the current web one, the classic one iOS still returns,
 * and paging across both.
 */

const LIST = "PLtest0000000000000000000000000000";
const PLAYLIST_URL = `https://www.youtube.com/playlist?list=${LIST}`;

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function lockup(id: string, title: string, duration: string) {
	return {
		lockupViewModel: {
			contentId: id,
			contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
			contentImage: {
				thumbnailViewModel: {
					image: { sources: [{ url: `https://i.ytimg.com/vi/${id}/hq.jpg` }] },
					overlays: [
						{
							thumbnailBottomOverlayViewModel: {
								badges: [{ thumbnailBadgeViewModel: { text: duration } }],
							},
						},
					],
				},
			},
			metadata: {
				lockupMetadataViewModel: {
					title: { content: title },
					metadata: {
						contentMetadataViewModel: {
							metadataRows: [
								{
									metadataParts: [
										{
											text: {
												content: "Some Channel",
												commandRuns: [
													{
														onTap: {
															innertubeCommand: {
																browseEndpoint: { browseId: "UC123" },
															},
														},
													},
												],
											},
										},
									],
								},
								{ metadataParts: [{ text: { content: "1M views" } }] },
							],
						},
					},
				},
			},
		},
	};
}

function classic(id: string, title: string, lengthSeconds: string) {
	return {
		playlistVideoRenderer: {
			videoId: id,
			title: { runs: [{ text: title }] },
			lengthSeconds,
			shortBylineText: {
				runs: [
					{
						text: "Some Channel",
						navigationEndpoint: { browseEndpoint: { browseId: "UC123" } },
					},
				],
			},
			thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/hq.jpg` }] },
		},
	};
}

function webPage(items: object[], continuation?: string) {
	return {
		metadata: { playlistMetadataRenderer: { title: "Test Playlist" } },
		contents: {
			items,
			...(continuation
				? {
						more: [
							{
								continuationItemRenderer: {
									continuationEndpoint: {
										continuationCommand: { token: continuation },
									},
								},
							},
						],
					}
				: {}),
		},
	};
}

/** Answer every browse call from `pages`, keyed by the continuation token. */
function stubBrowse(pages: Record<string, unknown>, onCall?: (body: any) => void) {
	const calls: any[] = [];
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		const body = JSON.parse(init.body as string);
		calls.push(body);
		onCall?.(body);
		const key = body.continuation ?? "first";
		const page = pages[key];
		if (!page) return new Response("", { status: 404 });
		return new Response(JSON.stringify(page), { status: 200 });
	}) as typeof fetch;
	return calls;
}

describe("getPlaylistId", () => {
	test("reads the list id off every shape of playlist link", () => {
		for (const url of [
			`https://www.youtube.com/playlist?list=${LIST}`,
			`https://youtube.com/playlist?list=${LIST}`,
			`https://m.youtube.com/playlist?list=${LIST}`,
			`https://music.youtube.com/playlist?list=${LIST}`,
			// What the share button hands out with a playlist open
			`https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${LIST}`,
			`https://youtu.be/dQw4w9WgXcQ?list=${LIST}`,
		]) {
			expect(getPlaylistId(url)).toBe(LIST);
		}
	});

	test("refuses mixes and personal lists, which browse cannot return", () => {
		// A mix is generated per session, so the link has to fall through to the
		// plain video it points at rather than fail as a playlist
		expect(getPlaylistId("https://www.youtube.com/watch?v=abc&list=RDabc")).toBeNull();
		expect(getPlaylistId("https://www.youtube.com/playlist?list=WL")).toBeNull();
		expect(getPlaylistId("https://www.youtube.com/playlist?list=LL")).toBeNull();
	});

	test("refuses anything that is not a YouTube playlist", () => {
		expect(getPlaylistId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
		expect(getPlaylistId(`https://example.com/playlist?list=${LIST}`)).toBeNull();
		expect(getPlaylistId("not a url")).toBeNull();
		expect(isPlaylistUrl(PLAYLIST_URL)).toBe(true);
	});
});

describe("fetchPlaylist", () => {
	test("reads the current web shape", async () => {
		stubBrowse({ first: webPage([lockup("vid00000001", "First", "3:55")]) });

		const playlist = await fetchPlaylist(PLAYLIST_URL);

		expect(playlist.title).toBe("Test Playlist");
		expect(playlist.url).toBe(PLAYLIST_URL);
		expect(playlist.videos).toEqual([
			{
				id: "vid00000001",
				url: "https://www.youtube.com/watch?v=vid00000001",
				title: "First",
				durationInSec: 235,
				channel: {
					name: "Some Channel",
					url: "https://www.youtube.com/channel/UC123",
				},
				thumbnails: [{ url: "https://i.ytimg.com/vi/vid00000001/hq.jpg" }],
			},
		]);
	});

	test("reads hour-long durations off the thumbnail badge", async () => {
		stubBrowse({ first: webPage([lockup("vid00000001", "Long", "1:02:03")]) });
		const playlist = await fetchPlaylist(PLAYLIST_URL);
		expect(playlist.videos[0]?.durationInSec).toBe(3723);
	});

	test("reads the classic shape", async () => {
		stubBrowse({ first: webPage([classic("vid00000001", "First", "235")]) });
		const playlist = await fetchPlaylist(PLAYLIST_URL);
		expect(playlist.videos[0]).toMatchObject({
			id: "vid00000001",
			title: "First",
			durationInSec: 235,
		});
	});

	test("follows continuations to the end of the playlist", async () => {
		const calls = stubBrowse({
			first: webPage([lockup("vid00000001", "First", "1:00")], "token-2"),
			"token-2": webPage([lockup("vid00000002", "Second", "2:00")], "token-3"),
			"token-3": webPage([lockup("vid00000003", "Third", "3:00")]),
		});

		const playlist = await fetchPlaylist(PLAYLIST_URL);

		expect(playlist.videos.map((video) => video.title)).toEqual([
			"First",
			"Second",
			"Third",
		]);
		expect(calls[0].browseId).toBe(`VL${LIST}`);
		expect(calls.map((call) => call.continuation)).toEqual([
			undefined,
			"token-2",
			"token-3",
		]);
	});

	test("stops when a continuation repeats the page it came from", async () => {
		// Otherwise a token that points at itself would page until the cap
		stubBrowse({
			first: webPage([lockup("vid00000001", "First", "1:00")], "loop"),
			loop: webPage([lockup("vid00000001", "First", "1:00")], "loop"),
		});

		const playlist = await fetchPlaylist(PLAYLIST_URL);

		expect(playlist.videos).toHaveLength(1);
	});

	test("keeps what it already has when a later page fails", async () => {
		stubBrowse({
			first: webPage([lockup("vid00000001", "First", "1:00")], "gone"),
		});
		const playlist = await fetchPlaylist(PLAYLIST_URL);
		expect(playlist.videos).toHaveLength(1);
	});

	test("falls back to the next client when the first returns nothing", async () => {
		const clients: string[] = [];
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string);
			clients.push(body.context.client.clientName);
			const page =
				body.context.client.clientName === "WEB"
					? webPage([])
					: webPage([classic("vid00000001", "First", "60")]);
			return new Response(JSON.stringify(page), { status: 200 });
		}) as typeof fetch;

		const playlist = await fetchPlaylist(PLAYLIST_URL);

		expect(clients).toEqual(["WEB", "IOS"]);
		expect(playlist.videos).toHaveLength(1);
	});

	test("throws when no client can read the playlist", async () => {
		// The caller has to tell this apart from an empty playlist: one is worth
		// reporting as an error, the other is not
		stubBrowse({});
		expect(fetchPlaylist(PLAYLIST_URL)).rejects.toThrow(/Could not read/);
	});

	test("throws on a link that is not a playlist", async () => {
		expect(
			fetchPlaylist("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
		).rejects.toThrow(/Not a YouTube playlist/);
	});
});
