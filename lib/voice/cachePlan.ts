/**
 * What a review of the song cache should delete.
 *
 * Pure, so the rules can be tested without a disk: the caller lists the cache
 * directory, this decides, and the caller unlinks.
 *
 * The directory is the only record. A track's last use is the mtime of its
 * `<id>.music`, which is bumped whenever it is played, so there is no side file
 * to drift out of step with what is actually on disk.
 */

export interface CacheFile {
	name: string;
	size: number;
	mtimeMs: number;
}

export interface CachePlanOptions {
	/** The size budget for the whole directory */
	maxBytes: number;
	now: number;
	/** Ids being downloaded or otherwise held: never touched */
	activeIds?: Iterable<string>;
	/** How long an untouched temp file is presumed to still be in flight */
	tempGraceMs?: number;
	/** How recently a track must have been used to be safe from eviction */
	useGraceMs?: number;
}

export interface CachePlan {
	/** File names to delete, in order */
	remove: string[];
	/** Size of everything the cache holds before the review */
	totalBytes: number;
	freedBytes: number;
}

export const TEMP_GRACE_MS = 5 * 60 * 1000;
/**
 * Covers the gap between a track being marked used and a player opening it.
 * Once open, deleting it is harmless: the reader keeps the file it has.
 */
export const USE_GRACE_MS = 10 * 60 * 1000;

type CacheKind = "music" | "index" | "tempMusic" | "tempIndex";

const SUFFIXES: [string, CacheKind][] = [
	// Longest first: `.temp.music` also ends with `.music`
	[".temp.music", "tempMusic"],
	[".temp.idx", "tempIndex"],
	[".music", "music"],
	[".idx", "index"],
];

/** Split a cache file name into its track id and what it holds */
export function parseCacheName(name: string) {
	for (const [suffix, kind] of SUFFIXES) {
		if (name.endsWith(suffix) && name.length > suffix.length) {
			return { id: name.slice(0, -suffix.length), kind };
		}
	}
	return null;
}

interface Track {
	music?: CacheFile;
	index?: CacheFile;
	hasTemp: boolean;
}

export function planCacheReview(
	files: CacheFile[],
	options: CachePlanOptions,
): CachePlan {
	const active = new Set(options.activeIds ?? []);
	const tempGrace = options.tempGraceMs ?? TEMP_GRACE_MS;
	const useGrace = options.useGraceMs ?? USE_GRACE_MS;
	const { now, maxBytes } = options;

	const remove: string[] = [];
	let totalBytes = 0;
	let freedBytes = 0;
	const drop = (file: CacheFile) => {
		remove.push(file.name);
		freedBytes += file.size;
	};

	const tracks = new Map<string, Track>();
	const track = (id: string) => {
		let entry = tracks.get(id);
		if (!entry) {
			entry = { hasTemp: false };
			tracks.set(id, entry);
		}
		return entry;
	};

	for (const file of files) {
		const parsed = parseCacheName(file.name);
		if (!parsed) continue; // .gitkeep and anything else that is not ours
		totalBytes += file.size;
		const entry = track(parsed.id);
		if (parsed.kind === "music") entry.music = file;
		else if (parsed.kind === "index") entry.index = file;
		else if (active.has(parsed.id) || now - file.mtimeMs < tempGrace) {
			entry.hasTemp = true;
		} else {
			// A download renames its temp files away on success, so one left
			// untouched with no download behind it is the remains of a crash
			drop(file);
		}
	}

	const evictable: (Track & { music: CacheFile })[] = [];
	for (const [id, entry] of tracks) {
		if (active.has(id)) continue;
		const { music, index } = entry;
		if (!music) {
			// An index describing audio that is gone, and not about to arrive
			if (index && !entry.hasTemp && now - index.mtimeMs >= tempGrace) {
				drop(index);
			}
			continue;
		}
		if (music.size === 0) {
			// Never a real track, and it would be served as one
			drop(music);
			if (index) drop(index);
			continue;
		}
		if (now - music.mtimeMs >= useGrace) evictable.push({ ...entry, music });
	}

	// Least recently used first, until the cache fits its budget
	evictable.sort((a, b) => a.music.mtimeMs - b.music.mtimeMs);
	for (const entry of evictable) {
		if (totalBytes - freedBytes <= maxBytes) break;
		drop(entry.music);
		if (entry.index) drop(entry.index);
	}

	return { remove, totalBytes, freedBytes };
}
