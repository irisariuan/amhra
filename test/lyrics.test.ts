import { afterEach, describe, expect, test } from "bun:test";
import {
	cleanChannel,
	delayLyrics,
	findLyrics,
	forgetLyrics,
	guessTitle,
	lineIndexAt,
	lyricsForTrack,
	parseLrc,
	scoreRecord,
	searchLyrics,
} from "../lib/lyrics";

/**
 * Lyrics lookup over LRCLIB.
 *
 * The network is stubbed: what is worth pinning down is how a YouTube title is
 * read and how records are ranked, since that is where a wrong match comes
 * from.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	forgetLyrics();
});

function record(overrides: Record<string, unknown> = {}) {
	return {
		id: 1,
		trackName: "Lemon",
		artistName: "米津玄師",
		albumName: "STRAY SHEEP",
		duration: 255,
		instrumental: false,
		plainLyrics: "夢ならばどれほど",
		syncedLyrics: "[00:02.72] 夢ならばどれほど",
		...overrides,
	};
}

describe("parseLrc", () => {
	test("reads stamps with two- and three-digit fractions", () => {
		expect(parseLrc("[00:02.72] one\n[01:05.123]two")).toEqual([
			{ time: 2720, text: "one" },
			{ time: 65123, text: "two" },
		]);
	});

	test("expands a line with several stamps and sorts by time", () => {
		expect(parseLrc("[00:30.00][00:10.00]chorus\n[00:20.00]verse")).toEqual([
			{ time: 10000, text: "chorus" },
			{ time: 20000, text: "verse" },
			{ time: 30000, text: "chorus" },
		]);
	});

	test("keeps empty lines as gaps and drops metadata", () => {
		expect(parseLrc("[ar:Someone]\n[ti:Song]\n[00:01.00]\n[00:02.00] a")).toEqual([
			{ time: 1000, text: "" },
			{ time: 2000, text: "a" },
		]);
	});

	test("applies the offset tag", () => {
		expect(parseLrc("[offset:+500]\n[00:02.00]a")).toEqual([
			{ time: 1500, text: "a" },
		]);
	});

	test("leaves brackets inside the text alone", () => {
		expect(parseLrc("[00:01.00]hey [laughs]")[0].text).toBe("hey [laughs]");
	});
});

describe("lineIndexAt", () => {
	const lines = parseLrc("[00:01.00]a\n[00:02.00]b\n[00:03.00]c");
	test("finds the line showing at a time", () => {
		expect(lineIndexAt(lines, 0)).toBe(-1);
		expect(lineIndexAt(lines, 1000)).toBe(0);
		expect(lineIndexAt(lines, 2500)).toBe(1);
		expect(lineIndexAt(lines, 99999)).toBe(2);
		expect(lineIndexAt([], 1000)).toBe(-1);
	});
});

describe("delayLyrics", () => {
	const lyrics = {
		id: 1,
		trackName: "Lemon",
		artistName: "米津玄師",
		albumName: null,
		duration: 255,
		instrumental: false,
		plain: "a\nb",
		synced: parseLrc("[00:01.00]a\n[00:03.00]b"),
	};

	test("moves every line later for a positive delay", () => {
		const delayed = delayLyrics(lyrics, 500);
		expect(delayed.synced?.map((l) => l.time)).toEqual([1500, 3500]);
		expect(lineIndexAt(delayed.synced!, 1200)).toBe(-1);
	});

	test("moves lines sooner for a negative delay, not before the start", () => {
		expect(delayLyrics(lyrics, -2000).synced?.map((l) => l.time)).toEqual([0, 1000]);
	});

	test("leaves the cached lyrics untouched", () => {
		delayLyrics(lyrics, 500);
		expect(lyrics.synced.map((l) => l.time)).toEqual([1000, 3000]);
		expect(delayLyrics(lyrics, 0)).toBe(lyrics);
	});
});

describe("guessTitle", () => {
	test("reads artist - track and drops upload noise", () => {
		expect(
			guessTitle("Rick Astley - Never Gonna Give You Up (Official Music Video)")[0],
		).toEqual({ track: "Never Gonna Give You Up", artist: "Rick Astley" });
	});

	test("reads the Japanese quoted title", () => {
		expect(guessTitle("米津玄師 MV「Lemon」", "米津玄師")[0]).toEqual({
			track: "Lemon",
			artist: "米津玄師",
		});
	});

	test("uses a Topic channel as the artist", () => {
		expect(guessTitle("Blinding Lights", "The Weeknd - Topic")).toEqual([
			{ track: "Blinding Lights", artist: "The Weeknd" },
		]);
	});

	test("drops featured artists from the track", () => {
		expect(guessTitle("Daft Punk - Get Lucky ft. Pharrell Williams")[0]).toEqual({
			track: "Get Lucky",
			artist: "Daft Punk",
		});
	});

	test("keeps brackets that are part of the name", () => {
		expect(guessTitle("IU - Palette (팔레트) [MV]")[0].track).toBe("Palette (팔레트)");
	});

	test("cleans channel suffixes", () => {
		expect(cleanChannel("RickAstleyVEVO")).toBe("RickAstley");
		expect(cleanChannel("Queen Official")).toBe("Queen");
	});
});

describe("scoreRecord", () => {
	const guesses = [{ track: "Lemon", artist: "米津玄師" }];

	test("rejects records whose name does not match", () => {
		expect(scoreRecord(record({ trackName: "Orange" }), guesses, 255)).toBe(0);
	});

	test("prefers a close duration, then synced lyrics", () => {
		const close = scoreRecord(record(), guesses, 256);
		const far = scoreRecord(record({ duration: 320 }), guesses, 256);
		const plain = scoreRecord(record({ syncedLyrics: null }), guesses, 256);
		expect(close).toBeGreaterThan(far);
		expect(close).toBeGreaterThan(plain);
	});
});

describe("findLyrics", () => {
	test("picks the best record across searches", async () => {
		const requested: string[] = [];
		globalThis.fetch = (async (input: string | URL) => {
			const url = new URL(input.toString());
			requested.push(url.search);
			return Response.json([
				record({ id: 2, duration: 320 }),
				record({ id: 3, duration: 274 }),
			]);
		}) as typeof fetch;
		const lyrics = await findLyrics({
			title: "米津玄師 MV「Lemon」",
			channel: "米津玄師",
			durationInSec: 275,
		});
		expect(lyrics?.id).toBe(3);
		expect(lyrics?.synced?.[0]).toEqual({ time: 2720, text: "夢ならばどれほど" });
		// A confident match on the first search stops there
		expect(requested).toHaveLength(1);
	});

	test("returns null when nothing plausible comes back", async () => {
		globalThis.fetch = (async () =>
			Response.json([record({ trackName: "Unrelated", artistName: "X" })])) as unknown as typeof fetch;
		expect(await findLyrics({ title: "rain sounds for sleeping" })).toBeNull();
	});
});

describe("lyricsForTrack", () => {
	const track = { url: "https://youtu.be/x", title: "Lemon", channel: "米津玄師" };

	test("caches by URL and shares concurrent lookups", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return Response.json([record()]);
		}) as unknown as typeof fetch;
		const [a, b] = await Promise.all([lyricsForTrack(track), lyricsForTrack(track)]);
		await lyricsForTrack(track);
		expect(a?.id).toBe(1);
		expect(b).toBe(a);
		expect(calls).toBe(1);
	});

	test("does not cache a failed request", async () => {
		globalThis.fetch = (async () =>
			new Response("", { status: 404 })) as unknown as typeof fetch;
		await expect(lyricsForTrack(track)).rejects.toThrow();
		globalThis.fetch = (async () => Response.json([record()])) as unknown as typeof fetch;
		expect((await lyricsForTrack(track))?.id).toBe(1);
	});
});

describe("searchLyrics", () => {
	test("prefers a record named like the query over a junk upload title", async () => {
		globalThis.fetch = (async () =>
			Response.json([
				record({ id: 9, trackName: "米津玄師 MV「Lemon」", artistName: "米津玄師 MV「Lemon」" }),
				record({ id: 1 }),
			])) as unknown as typeof fetch;
		expect((await searchLyrics("米津玄師 Lemon"))?.id).toBe(1);
	});

	test("demotes a track name with the artist baked in", async () => {
		globalThis.fetch = (async () =>
			Response.json([
				record({ id: 9, trackName: "Bohemian Rhapsody - Queen", artistName: "Queen" }),
				record({ id: 1, trackName: "Bohemian Rhapsody", artistName: "Queen", syncedLyrics: null }),
			])) as unknown as typeof fetch;
		expect((await searchLyrics("bohemian rhapsody queen"))?.id).toBe(1);
	});
});
