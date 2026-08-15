import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	fetchPlaylist,
	forgetPlaylists,
	forgetVisitorData,
	getPlaylistId,
	isPlaylistUrl,
	readPlaylist,
	scrapeVisitorData,
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

describe("scrapeVisitorData", () => {
	test("pulls the id out of the home page's inline config", () => {
		const page = `<script>ytcfg.set({"INNERTUBE_CONTEXT":{"client":{"visitorData":"CgtBQkNERUZHSElKSxi7-abBBjIKCgJVUxIEGgAgYQ%3D%3D","hl":"en"}}});</script>`;
		expect(scrapeVisitorData(page)).toBe(
			"CgtBQkNERUZHSElKSxi7-abBBjIKCgJVUxIEGgAgYQ%3D%3D",
		);
	});

	test("refuses a page with no id, and a truncated one", () => {
		// Sending a placeholder is worse than sending nothing.
		expect(scrapeVisitorData("<html>no config here</html>")).toBeNull();
		expect(scrapeVisitorData('{"visitorData":"short"}')).toBeNull();
	});
});

describe("visitorData on a browse call", () => {
	const VISITOR = "CgtBQkNERUZHSElKSxi7-abBBjIKCgJVUxIEGgAgYQ%3D%3D";

	beforeEach(() => {
		forgetVisitorData();
		forgetPlaylists();
	});
	afterEach(() => forgetVisitorData());

	/** Serve the home page to the mint, and one playlist page to browse. */
	function stubWithMint(homePage: string) {
		const headers: (string | undefined)[] = [];
		const bodies: any[] = [];
		globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
			if (!init.body) return new Response(homePage, { status: 200 });
			headers.push(
				(init.headers as Record<string, string>)["x-goog-visitor-id"],
			);
			bodies.push(JSON.parse(init.body as string));
			return new Response(
				JSON.stringify(webPage([lockup("vid00000001", "First", "1:00")])),
				{ status: 200 },
			);
		}) as typeof fetch;
		return { headers, bodies };
	}

	test("sends the minted id in the context and the header", async () => {
		// The Rust fetcher mints one per process because an InnerTube call
		// without it is answered as if nobody asked. This module was making the
		// same call with no id at all.
		const { headers, bodies } = stubWithMint(
			`<script>ytcfg.set({"visitorData":"${VISITOR}"});</script>`,
		);

		await fetchPlaylist(PLAYLIST_URL);

		expect(bodies[0].context.client.visitorData).toBe(VISITOR);
		expect(headers[0]).toBe(VISITOR);
	});

	test("still browses when the id cannot be minted", async () => {
		const { headers, bodies } = stubWithMint("<html>nothing here</html>");

		const playlist = await fetchPlaylist(PLAYLIST_URL);

		expect(playlist.videos).toHaveLength(1);
		expect(bodies[0].context.client.visitorData).toBeUndefined();
		expect(headers[0]).toBeUndefined();
	});
});

describe("readPlaylist", () => {
	beforeEach(() => forgetPlaylists());

	test("reuses a recent read of the same playlist", async () => {
		// The dashboard previews a link and then queues it. Walking every
		// continuation page twice for one user action is the cost this avoids.
		const calls = stubBrowse({
			first: webPage([lockup("vid00000001", "First", "1:00")]),
		});

		const first = await readPlaylist(PLAYLIST_URL);
		const second = await readPlaylist(PLAYLIST_URL);

		expect(second).toBe(first);
		expect(calls).toHaveLength(1);
	});

	test("matches a watch link against the playlist link it shares an id with", async () => {
		// The preview and the queueing rarely arrive spelt the same way.
		const calls = stubBrowse({
			first: webPage([lockup("vid00000001", "First", "1:00")]),
		});

		await readPlaylist(`https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${LIST}`);
		await readPlaylist(PLAYLIST_URL);

		expect(calls).toHaveLength(1);
	});

	test("reads again once the entry has aged out", async () => {
		const calls = stubBrowse({
			first: webPage([lockup("vid00000001", "First", "1:00")]),
		});

		await readPlaylist(PLAYLIST_URL, 0);
		await readPlaylist(PLAYLIST_URL, 31 * 60 * 1000);

		expect(calls).toHaveLength(2);
	});

	test("caches nothing when the read fails", async () => {
		stubBrowse({});
		expect(readPlaylist(PLAYLIST_URL)).rejects.toThrow(/Could not read/);
	});

	test("throws on a link that is not a playlist", async () => {
		expect(readPlaylist("https://www.youtube.com/watch?v=abc")).rejects.toThrow(
			/Not a YouTube playlist/,
		);
	});
});
