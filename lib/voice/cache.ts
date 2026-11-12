import { existsSync } from "node:fs";
import { readdir, readFile, stat, unlink, utimes } from "node:fs/promises";
import { dcb } from "../misc";
import { readSetting } from "../setting";
import { type CacheFile, planCacheReview } from "./cachePlan";

/**
 * The song cache: one directory of `<id>.music` files, each with an optional
 * `<id>.idx` seek index, plus `<id>.temp.*` while a download is in flight.
 *
 * Everything that names a cache file goes through here, so the layout lives in
 * one place (the Rust fetcher and sidecar mirror it in `CachePaths`).
 *
 * There is no separate record of what was used when: a track's last use is the
 * mtime of its `.music` file, see {@link markUsed}.
 */

export const cacheDir = () => `${process.cwd()}/cache`;
export const musicPath = (id: string, dir = cacheDir()) => `${dir}/${id}.music`;
export const tempMusicPath = (id: string, dir = cacheDir()) =>
	`${dir}/${id}.temp.music`;
export const indexPath = (id: string, dir = cacheDir()) => `${dir}/${id}.idx`;

/** Whether the whole track is on disk */
export function isCached(id: string, dir = cacheDir()) {
	return existsSync(musicPath(id, dir));
}

/**
 * Record that a track was just used, so it is the last to be evicted.
 *
 * A track still downloading has no `.music` yet; that is fine, it gets a fresh
 * mtime when the download renames it into place.
 */
export async function markUsed(id: string, dir = cacheDir()) {
	const now = new Date();
	await utimes(musicPath(id, dir), now, now).catch(() => {});
}

/** Delete a track and its index, e.g. after a download that cannot be trusted */
export async function dropCached(id: string, dir = cacheDir()) {
	await Promise.all([
		unlink(musicPath(id, dir)).catch(() => {}),
		unlink(indexPath(id, dir)).catch(() => {}),
	]);
}

async function listCache(dir: string): Promise<CacheFile[]> {
	const names = await readdir(dir).catch(() => [] as string[]);
	const files = await Promise.all(
		names.map((name) =>
			// A file can be removed between the listing and the stat
			stat(`${dir}/${name}`).then(
				(info) => ({ name, size: info.size, mtimeMs: info.mtimeMs }),
				() => null,
			),
		),
	);
	return files.filter((file) => file !== null);
}

export async function getFolderSize(dir = cacheDir()) {
	let total = 0;
	for (const file of await listCache(dir)) total += file.size;
	return total;
}

async function review(activeIds: string[], dir: string, maxBytes: number) {
	const plan = planCacheReview(await listCache(dir), {
		maxBytes,
		now: Date.now(),
		activeIds,
	});
	if (!plan.remove.length) return plan;
	await Promise.all(
		plan.remove.map((name) => unlink(`${dir}/${name}`).catch(() => {})),
	);
	dcb.log(
		`Cache review: removed ${plan.remove.length} file(s), freed ${plan.freedBytes} of ${plan.totalBytes} bytes (limit ${maxBytes})`,
	);
	return plan;
}

let reviewing: Promise<unknown> = Promise.resolve();

/**
 * Clear out what downloads left behind and, when the cache is over
 * `MAX_CACHE_IN_GB`, evict the least recently used tracks until it fits.
 *
 * `activeIds` are the tracks being downloaded right now; they and anything used
 * in the last few minutes are left alone. Reviews run one at a time, so two
 * finishing downloads cannot both act on the same stale listing.
 */
export function reviewCaches(
	activeIds: Iterable<string> = [],
	dir = cacheDir(),
	maxBytes = readSetting().MAX_CACHE_IN_GB * 1024 * 1024 * 1024,
) {
	const ids = [...activeIds];
	const run = reviewing.then(() => review(ids, dir, maxBytes));
	reviewing = run.catch((error) => {
		dcb.log(`Cache review failed: ${error}`);
	});
	return run;
}

/**
 * Carry over the last-used times from `data/lastUsed.record`, the side file
 * older versions kept, then delete it. Runs once; a no-op afterwards.
 */
export async function migrateLastUsedRecord(
	record = `${process.cwd()}/data/lastUsed.record`,
	dir = cacheDir(),
) {
	const content = await readFile(record, "utf8").catch(() => null);
	if (content === null) return;
	for (const line of content.split("\n")) {
		const [id, lastUsed] = line.split("=");
		const time = Number(lastUsed);
		if (!id || !Number.isFinite(time) || time <= 0) continue;
		const date = new Date(time);
		await utimes(musicPath(id, dir), date, date).catch(() => {});
	}
	await unlink(record).catch(() => {});
}
