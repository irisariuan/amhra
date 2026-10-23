import { afterEach, describe, expect, test } from "bun:test";
import { YtdlError } from "@distube/ytdl-core";
import { getUpcoming, parseUpcoming, upcomingFrom } from "../lib/premiere";
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

describe("upcomingFrom", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
		forgetVisitorData();
	});

	/** InnerTube answering `answer`, or failing with none; counts the asks. */
	function innertube(answer: unknown) {
		const asked: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = String(input);
			asked.push(url);
			if (!url.includes("/youtubei/") || answer === undefined) return new Response("", { status: 500 });
			return new Response(JSON.stringify(answer));
		}) as typeof fetch;
		return asked;
	}

	const notStarted = (startTime?: Date) =>
		new YtdlError("NOT_STARTED", "Could not play x2AJxEQBD9o: This live event will begin in 16 hours.", {
			...(startTime ? { startTime } : {}),
		});

	test("any other refusal is not a premiere, and asks nothing more", async () => {
		const asked = innertube(upcoming);
		expect(await upcomingFrom(new YtdlError("PRIVATE", "Video unavailable"), "x2AJxEQBD9o")).toBeNull();
		expect(await upcomingFrom(new Error("fetch failed"), "x2AJxEQBD9o")).toBeNull();
		expect(await upcomingFrom(undefined, "x2AJxEQBD9o")).toBeNull();
		expect(asked).toHaveLength(0);
	});

	test("a premiere is looked up for its title", async () => {
		innertube(upcoming);
		expect(await upcomingFrom(notStarted(new Date(1792643400_000)), "x2AJxEQBD9o")).toEqual({
			videoId: "x2AJxEQBD9o",
			url: "https://www.youtube.com/watch?v=x2AJxEQBD9o",
			title: "A premiere",
			channel: "Some Channel",
			startsAt: 1792643400_000,
		});
	});

	test("without that lookup, ytdl-core's start time schedules it by its link", async () => {
		innertube(undefined);
		expect(await upcomingFrom(notStarted(new Date(1792643400_000)), "x2AJxEQBD9o")).toEqual({
			videoId: "x2AJxEQBD9o",
			url: "https://www.youtube.com/watch?v=x2AJxEQBD9o",
			title: "https://www.youtube.com/watch?v=x2AJxEQBD9o",
			channel: "",
			startsAt: 1792643400_000,
		});
	});

	test("with no start time anywhere, there is nothing to schedule", async () => {
		innertube(undefined);
		expect(await upcomingFrom(notStarted(), "x2AJxEQBD9o")).toBeNull();
	});
});
