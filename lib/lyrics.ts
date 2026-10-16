import z from "zod";
import { globalApp } from "./misc";

/**
 * Lyrics from LRCLIB (https://lrclib.net), a free, keyless lyrics database
 * with time-synced (LRC) lyrics for most tracks.
 *
 * The hard part is not the API but the input: what the bot knows is a YouTube
 * title and channel, which look like "Artist - Song (Official Video)" or
 * "米津玄師 MV「Lemon」" rather than a clean track and artist. So a lookup
 * guesses a few (track, artist) readings of the title, searches for each, and
 * scores every result against the guesses and the video's duration.
 */

const API = "https://lrclib.net/api";
// LRCLIB asks clients to identify themselves
const USER_AGENT = "Amhra (https://github.com/irisariuan/amhra)";

const recordSchema = z.object({
	id: z.number(),
	trackName: z.string(),
	artistName: z.string(),
	albumName: z.string().nullish(),
	duration: z.number().nullish(),
	instrumental: z.boolean().nullish(),
	plainLyrics: z.string().nullish(),
	syncedLyrics: z.string().nullish(),
});
type LrclibRecord = z.infer<typeof recordSchema>;

export interface LyricLine {
	/** Milliseconds from the start of the track */
	time: number;
	/** Empty for an instrumental gap */
	text: string;
}

export interface Lyrics {
	id: number;
	trackName: string;
	artistName: string;
	albumName: string | null;
	/** Seconds, as LRCLIB has it — not necessarily the video's length */
	duration: number | null;
	instrumental: boolean;
	plain: string | null;
	synced: LyricLine[] | null;
}

export interface LyricsQuery {
	title: string;
	channel?: string;
	durationInSec?: number;
}

// ---- Parsing ----

const TIME_TAG = /\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/**
 * Parses LRC into lines sorted by time.
 *
 * Handles several stamps on one line (`[00:10.00][01:10.00]chorus`), two- or
 * three-digit fractions, and the `[offset:±ms]` tag; other metadata tags
 * (`[ar:…]`, `[ti:…]`) are dropped.
 */
export function parseLrc(lrc: string): LyricLine[] {
	let offset = 0;
	const lines: LyricLine[] = [];
	for (const raw of lrc.split(/\r?\n/)) {
		const offsetTag = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
		if (offsetTag) {
			offset = Number(offsetTag[1]);
			continue;
		}
		const times: number[] = [];
		let rest = raw.trimStart();
		// Stamps only count at the start; a bracket mid-line is lyric text
		while (true) {
			TIME_TAG.lastIndex = 0;
			const match = TIME_TAG.exec(rest);
			if (!match || match.index !== 0) break;
			const [, min, sec, frac = "0"] = match;
			const ms = Number(frac.padEnd(3, "0").slice(0, 3));
			times.push(Number(min) * 60_000 + Number(sec) * 1000 + ms);
			rest = rest.slice(match[0].length);
		}
		const text = rest.trim();
		for (const time of times) lines.push({ time, text });
	}
	// A positive offset means the lyrics should appear sooner
	return lines
		.map((line) => ({ ...line, time: Math.max(0, line.time - offset) }))
		.sort((a, b) => a.time - b.time);
}

/** Index of the line showing at `ms`, or -1 before the first one. */
export function lineIndexAt(lines: LyricLine[], ms: number): number {
	let lo = 0;
	let hi = lines.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (lines[mid].time <= ms) {
			found = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return found;
}

// ---- Reading a YouTube title ----

// Bracketed asides that describe the upload rather than the song
const NOISE =
	/official|video|audio|lyrics?|visuali[sz]er|music|\bmv\b|\bm\/v\b|\bpv\b|\bhd\b|\bhq\b|\b4k\b|\b1080p\b|remaster(ed)?|topic|歌詞|字幕|中字|動態|color coded|eng|rom|full ver/i;
const BRACKETS = /\(([^)]*)\)|\[([^\]]*)\]|【([^】]*)】|〔([^〕]*)〕/g;
const QUOTES = /[「『]([^」』]+)[」』]/;
const SEPARATORS = /\s+[-–—|_]\s+|\s*[｜]\s*/;

function stripNoise(text: string) {
	return text
		.replace(BRACKETS, (whole, ...groups: (string | undefined)[]) => {
			const inner = groups.slice(0, 4).find((g) => g !== undefined) ?? "";
			return NOISE.test(inner) ? " " : whole;
		})
		.replace(/\b(official\s+)?(music\s+)?(video|audio|mv)\b\s*$/i, "")
		.replace(/\s+/g, " ")
		.trim();
}

function stripFeat(text: string) {
	return text
		.replace(/\s*[([]?\s*\b(feat|ft|featuring)\b\.?.*$/i, "")
		.trim();
}

export function cleanChannel(channel: string) {
	return channel
		.replace(/\s*-\s*Topic$/i, "")
		.replace(/VEVO$/i, "")
		.replace(/\s*(official|官方)(\s+(channel|youtube))?\s*$/i, "")
		.trim();
}

export interface TitleGuess {
	track: string;
	artist?: string;
}

/**
 * Plausible (track, artist) readings of a video title, best first.
 *
 * "A - B" is read both ways round, since uploads use either order; a quoted
 * 「title」 is the usual Japanese convention; and the channel stands in for
 * the artist when the title names none, which is exactly the shape of the
 * auto-generated "Artist - Topic" uploads.
 */
export function guessTitle(title: string, channel?: string): TitleGuess[] {
	const cleaned = stripNoise(title);
	const artistFromChannel = channel ? cleanChannel(channel) : undefined;
	const guesses: TitleGuess[] = [];

	const quoted = cleaned.match(QUOTES);
	if (quoted) {
		const before = stripNoise(cleaned.slice(0, quoted.index)).trim();
		guesses.push({
			track: quoted[1].trim(),
			artist: before || artistFromChannel,
		});
	}

	const parts = cleaned.split(SEPARATORS).map((p) => p.trim()).filter(Boolean);
	if (parts.length >= 2) {
		const [first, second] = parts;
		guesses.push({ track: stripFeat(second), artist: stripFeat(first) });
		guesses.push({ track: stripFeat(first), artist: stripFeat(second) });
	}

	guesses.push({ track: stripFeat(cleaned), artist: artistFromChannel });

	const seen = new Set<string>();
	return guesses.filter((g) => {
		const key = `${normalize(g.track)}|${normalize(g.artist ?? "")}`;
		if (!g.track || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

// ---- Matching ----

function normalize(text: string) {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\s\p{P}\p{S}]+/gu, "");
}

function loosely(a: string, b: string) {
	const x = normalize(a);
	const y = normalize(b);
	if (!x || !y) return 0;
	if (x === y) return 2;
	return x.includes(y) || y.includes(x) ? 1 : 0;
}

/**
 * How well a record fits the guesses. Name agreement is required; duration and
 * synced lyrics decide between records that agree.
 *
 * Duration is a weak signal for videos — an MV with an intro can run twenty
 * seconds past the studio cut — so it rewards a close match rather than
 * rejecting a far one.
 */
export function scoreRecord(
	record: LrclibRecord,
	guesses: TitleGuess[],
	durationInSec?: number,
): number {
	let names = 0;
	for (const guess of guesses) {
		const track = Math.max(
			loosely(record.trackName, guess.track),
			// Some records carry the whole upload title as the track name
			loosely(record.trackName, `${guess.artist ?? ""}${guess.track}`),
		);
		if (track === 0) continue;
		const artist = guess.artist ? loosely(record.artistName, guess.artist) : 0;
		names = Math.max(names, track * 2 + artist);
	}
	if (names === 0) return 0;

	let score = names;
	if (durationInSec && record.duration) {
		const diff = Math.abs(record.duration - durationInSec);
		if (diff <= 3) score += 3;
		else if (diff <= 10) score += 1.5;
		else if (diff > 45) score -= 1;
	}
	if (record.syncedLyrics) score += 1;
	if (!record.plainLyrics && !record.syncedLyrics && !record.instrumental)
		score -= 5;
	return score;
}

function toLyrics(record: LrclibRecord): Lyrics {
	const synced = record.syncedLyrics ? parseLrc(record.syncedLyrics) : null;
	return {
		id: record.id,
		trackName: record.trackName,
		artistName: record.artistName,
		albumName: record.albumName ?? null,
		duration: record.duration ?? null,
		instrumental: record.instrumental ?? false,
		plain: record.plainLyrics?.trim() || null,
		synced: synced?.length ? synced : null,
	};
}

// ---- Fetching ----

async function search(params: Record<string, string>): Promise<LrclibRecord[]> {
	const url = new URL(`${API}/search`);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	const request = () =>
		fetch(url, {
			headers: { "user-agent": USER_AGENT },
			signal: AbortSignal.timeout(10_000),
		});
	let res = await request();
	// LRCLIB sheds load with bursts of 503s that clear within a second or two
	for (const delay of [500, 1500]) {
		if (res.status < 500) break;
		await new Promise((r) => setTimeout(r, delay));
		res = await request();
	}
	if (!res.ok) throw new Error(`LRCLIB search responded ${res.status}`);
	const parsed = z.array(recordSchema).safeParse(await res.json());
	if (!parsed.success) throw new Error("LRCLIB search returned an unknown shape");
	return parsed.data;
}

/** Below this, a record agrees with the title too little to be shown. */
const MIN_SCORE = 2;

/**
 * The best lyrics for a video, or null when nothing plausible exists.
 *
 * Searches stop at the first guess that yields a confident match, so a clean
 * title costs one request; a messy one costs at most a handful.
 */
export async function findLyrics(query: LyricsQuery): Promise<Lyrics | null> {
	const guesses = guessTitle(query.title, query.channel);
	const requests: Record<string, string>[] = [];
	for (const guess of guesses) {
		if (guess.artist) {
			requests.push({ track_name: guess.track, artist_name: guess.artist });
		}
	}
	requests.push({ q: stripNoise(query.title) });
	if (guesses[0]) requests.push({ q: guesses[0].track });

	let best: { record: LrclibRecord; score: number } | null = null;
	const tried = new Set<string>();
	for (const params of requests) {
		const key = JSON.stringify(params);
		if (tried.has(key)) continue;
		tried.add(key);
		const records = await search(params);
		for (const record of records) {
			const score = scoreRecord(record, guesses, query.durationInSec);
			if (score > (best?.score ?? 0)) best = { record, score };
		}
		// Name, artist and duration all agreeing is as good as it gets
		if (best && best.score >= 7) break;
	}
	return best && best.score >= MIN_SCORE ? toLyrics(best.record) : null;
}

/**
 * Lyrics for free text the user typed, for when the automatic match is wrong.
 * The user said what they want, so the top result with lyrics wins.
 */
export async function searchLyrics(
	text: string,
	durationInSec?: number,
): Promise<Lyrics | null> {
	const records = await search({ q: text });
	const query = normalize(text);
	const ranked = records
		.filter((r) => r.plainLyrics || r.syncedLyrics || r.instrumental)
		.map((record, index) => {
			// The typed text usually names the track and often the artist; a
			// record carrying the whole upload title as its name matches neither
			const track = normalize(record.trackName);
			const artist = normalize(record.artistName);
			let named =
				track && query.includes(track)
					? artist && query.includes(artist)
						? 3
						: 1.5
					: 0;
			// "Song - Artist" as a track name is an upload title, not a track
			if (named && artist && track.includes(artist)) named -= 1;
			const close =
				durationInSec &&
				record.duration &&
				Math.abs(record.duration - durationInSec) <= 3;
			return {
				record,
				// LRCLIB's order only breaks ties
				score:
					named +
					(close ? 2 : 0) +
					(record.syncedLyrics ? 0.5 : 0) -
					index * 0.05,
			};
		})
		.sort((a, b) => b.score - a.score);
	return ranked[0] ? toLyrics(ranked[0].record) : null;
}

// ---- Caching ----

interface CacheEntry {
	value: Lyrics | null;
	at: number;
}

const FOUND_TTL = 12 * 60 * 60 * 1000;
// A miss may be filled in later (LRCLIB is crowd-sourced), so retry sooner
const MISSING_TTL = 30 * 60 * 1000;
const MAX_ENTRIES = 500;
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<Lyrics | null>>();

/**
 * Cached lookup keyed by `key` (a video URL, or the typed text).
 *
 * The Discord command and the dashboard ask for the same track at the same
 * time, so concurrent calls share one lookup. A failed request is not cached:
 * it says nothing about whether lyrics exist.
 */
export async function getLyrics(
	key: string,
	lookup: () => Promise<Lyrics | null>,
): Promise<Lyrics | null> {
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < (hit.value ? FOUND_TTL : MISSING_TTL)) {
		// Re-insert so the map's order tracks recency for eviction
		cache.delete(key);
		cache.set(key, hit);
		return hit.value;
	}
	const inflight = pending.get(key);
	if (inflight) return inflight;

	const promise = lookup()
		.then((value) => {
			cache.set(key, { value, at: Date.now() });
			while (cache.size > MAX_ENTRIES) {
				cache.delete(cache.keys().next().value as string);
			}
			return value;
		})
		.catch((error) => {
			globalApp.warn(`Lyrics lookup failed for ${key}: ${error}`);
			throw error;
		})
		.finally(() => pending.delete(key));
	pending.set(key, promise);
	return promise;
}

export function forgetLyrics() {
	cache.clear();
	pending.clear();
}

/** Lyrics for a playing track, by its URL. */
export function lyricsForTrack(track: {
	url: string;
	title: string;
	channel?: string;
	durationInSec?: number;
}) {
	return getLyrics(track.url, () =>
		findLyrics({
			title: track.title,
			channel: track.channel,
			durationInSec: track.durationInSec,
		}),
	);
}

/** Lyrics for text the user typed, optionally ranked against a duration. */
export function lyricsForQuery(text: string, durationInSec?: number) {
	const query = text.trim();
	return getLyrics(`q:${normalize(query)}:${durationInSec ?? ""}`, () =>
		searchLyrics(query, durationInSec),
	);
}
