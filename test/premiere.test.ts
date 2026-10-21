import { afterEach, describe, expect, test } from "bun:test";
import { getUpcoming, parseUpcoming } from "../lib/premiere";
import { forgetVisitorData } from "../lib/youtubePlaylist";

/**
 * Reading a premiere's start time out of an InnerTube `player` response.
 *
 * The shape below is trimmed from a real upcoming stream's response; the
 * fields kept are the ones the parser reads.
 */

const upcoming = {
	playabilityStatus: {
		status: "LIVE_STREAM_OFFLINE",
		reason: "This live event will begin in 16 hours.",
		liveStreamability: {
			liveStreamabilityRenderer: {
				videoId: "x2AJxEQBD9o",
				offlineSlate: {
					liveStreamOfflineSlateRenderer: { scheduledStartTime: "1792643400" },
				},
			},
		},
	},
	videoDetails: {
		videoId: "x2AJxEQBD9o",
		title: "A premiere",
		author: "Some Channel",
		isUpcoming: true,
		isLiveContent: true,
		lengthSeconds: "0",
	},
	microformat: {
		playerMicroformatRenderer: {
			liveBroadcastDetails: {
				isLiveNow: false,
				startTimestamp: "2026-10-22T04:30:00+00:00",
			},
		},
	},
};

describe("parseUpcoming", () => {
	test("reads the offline slate's start time", () => {
		expect(parseUpcoming(upcoming)).toEqual({
			videoId: "x2AJxEQBD9o",
			url: "https://www.youtube.com/watch?v=x2AJxEQBD9o",
			title: "A premiere",
			channel: "Some Channel",
			startsAt: 1792643400_000,
		});
	});

	test("falls back to the broadcast details when the slate is missing", () => {
		const { liveStreamability: _, ...playability } = upcoming.playabilityStatus;
		expect(
			parseUpcoming({ ...upcoming, playabilityStatus: playability })?.startsAt,
		).toBe(Date.parse("2026-10-22T04:30:00+00:00"));
	});

	test("an ordinary video is not upcoming", () => {
		expect(
			parseUpcoming({
				playabilityStatus: { status: "OK" },
				videoDetails: { videoId: "dQw4w9WgXcQ", title: "x", lengthSeconds: "213" },
			}),
		).toBeNull();
	});

	test("an upcoming video with no start time cannot be scheduled", () => {
		expect(
			parseUpcoming({
				playabilityStatus: { status: "LIVE_STREAM_OFFLINE" },
				videoDetails: { videoId: "x2AJxEQBD9o", isUpcoming: true },
			}),
		).toBeNull();
	});

	test("nothing in, nothing out", () => {
		expect(parseUpcoming(null)).toBeNull();
	});
});

describe("getUpcoming", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
		forgetVisitorData();
	});

	test("asks the player endpoint for the video", async () => {
		const bodies: Record<string, any>[] = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (!url.includes("/youtubei/")) return new Response("", { status: 500 });
			expect(url).toContain("/youtubei/v1/player");
			bodies.push(JSON.parse(String(init?.body)));
			return new Response(JSON.stringify(upcoming));
		}) as typeof fetch;

		expect((await getUpcoming("x2AJxEQBD9o"))?.startsAt).toBe(1792643400_000);
		expect(bodies[0].videoId).toBe("x2AJxEQBD9o");
	});
});
