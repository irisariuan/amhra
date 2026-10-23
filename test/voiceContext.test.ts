import { describe, expect, test } from "bun:test";
import type { CustomClient } from "../lib/custom";
import { describePlayback, type PlaybackState, playbackState, QUEUE_SHOWN } from "../lib/voice/voiceContext";

/**
 * What the voice command model is told about the bot: what is playing, the
 * queue with whatever titles are known in time, the volume and the settings.
 */

const STATE: PlaybackState = {
	nowPlaying: {
		url: "https://youtu.be/a",
		title: "bad guy",
		channel: "Billie Eilish",
		duration: 194,
		positionMs: 83_000,
	},
	paused: true,
	queueLength: 12,
	queue: [
		{ url: "https://youtu.be/b", title: "Hello", channel: "Adele", duration: 367 },
		{ url: "https://youtu.be/c", repeating: true },
	],
	volume: 80,
	muted: false,
	loop: true,
	autoSuggest: false,
	autoSkipNonMusic: true,
	crossfadeMs: 3000,
	mix: [{ title: "Rain sounds", volume: 30 }],
	mixMainVolume: 100,
};

describe("the state as the model reads it", () => {
	test("each part on its own line", () => {
		expect(describePlayback(STATE).split("\n")).toEqual([
			'Now playing: "bad guy" by Billie Eilish, 3:14, at 1:23 of 3:14 (paused)',
			"Queue (12 songs, next first):",
			'1. "Hello" by Adele, 6:07',
			"2. https://youtu.be/c (title not looked up) (repeats)",
			"…and 10 more",
			"Volume: 80%",
			"Loop: on. Suggesting songs when the queue runs out: off. Skipping non-music parts automatically: on. Crossfade: 3s.",
			"Mixed in over the queue's song (at 100%):",
			'1. "Rain sounds" at 30%',
		]);
	});

	test("nothing at all", () => {
		expect(describePlayback(null)).toBe("Nothing is playing and the queue is empty.");
		const idle = describePlayback({ ...STATE, nowPlaying: null, queueLength: 0, queue: [], mix: [], muted: true });
		expect(idle).toContain("Now playing: nothing\nQueue: empty\nVolume: 80% (muted)");
		expect(idle).not.toContain("Mixed in");
	});
});

describe("gathering it", () => {
	/** A client whose player has `urls` queued, with `cached` titles known. */
	function client(urls: string[], cached: Record<string, string> = {}) {
		const player = {
			queue: urls.map((url) => ({ url, repeating: false })),
			isPlaying: false,
			nowPlaying: null,
			isPaused: false,
			volume: 1.5,
			isMuting: false,
			customSetting: {},
			native: false,
			crossfadeMs: 0,
			getCurrentSongPosition: () => null,
		};
		return {
			player: new Map([["g", player]]),
			cache: {
				getUrl: (url: string) =>
					cached[url]
						? { isVideo: () => true, value: { title: cached[url], channel: { name: "C" }, durationInSec: 60 } }
						: null,
			},
		} as unknown as CustomClient;
	}

	test("known titles at once, quick lookups in time, slow ones by their link", async () => {
		const looked: string[] = [];
		const lookup = async (url: string) => {
			looked.push(url);
			if (url === "slow") await new Promise((done) => setTimeout(done, 500));
			return { title: `found ${url}` };
		};
		const started = Date.now();
		const state = await playbackState(client(["known", "quick", "slow"], { known: "Known" }), "g", {
			within: 50,
			lookup,
			mixOf: async () => undefined,
		});
		expect(Date.now() - started).toBeLessThan(400);
		expect(looked).toEqual(["quick", "slow"]);
		expect(state?.queue.map((song) => song.title)).toEqual(["Known", "found quick", undefined]);
		expect(state?.volume).toBe(150);
	});

	test("only the front of a long queue", async () => {
		const urls = Array.from({ length: QUEUE_SHOWN + 5 }, (_, index) => `u${index}`);
		const state = await playbackState(client(urls), "g", { within: 1, lookup: async () => null, mixOf: async () => undefined });
		expect(state?.queue).toHaveLength(QUEUE_SHOWN);
		expect(state?.queueLength).toBe(QUEUE_SHOWN + 5);
	});

	test("no player, nothing to tell", async () => {
		expect(await playbackState(client([]), "other")).toBeNull();
	});
});
