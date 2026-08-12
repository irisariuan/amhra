import { readdirSync } from "node:fs";
import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dcb } from "../misc";
import { readSetting } from "../setting";

export async function getFolderSize() {
	let totalSize = 0;
	for (const filename of await readdir(`${process.cwd()}/cache`)) {
		// A file can be removed between the listing and the stat
		const size = await stat(`${process.cwd()}/cache/${filename}`)
			.then((info) => info.size)
			.catch(() => 0);
		totalSize += size;
	}
	return totalSize;
}

const TEMP_SUFFIX = ".temp.music";
/** How recently a temp file must have been touched to be presumed still in use */
const TEMP_GRACE_MS = 5 * 60 * 1000;

/**
 * Delete `.temp.music` files no download owns any more.
 *
 * A download writes to `<id>.temp.music` and renames it on success, so a temp
 * file left behind is the remains of a crash or a kill. Nothing ever promotes
 * or reads one again, but they still count towards the cache size budget, and
 * the size review only ever looks at `<id>.music` — so without this they
 * accumulate forever.
 *
 * Files belonging to a live download are protected twice: by the active id list
 * and by their recent mtime.
 */
export async function collectOrphanedTemps(activeIds: string[] = []) {
	const active = new Set(activeIds);
	const directory = `${process.cwd()}/cache`;
	const filenames = await readdir(directory).catch(() => [] as string[]);
	let removed = 0;
	let freed = 0;
	for (const filename of filenames) {
		if (!filename.endsWith(TEMP_SUFFIX)) continue;
		if (active.has(filename.slice(0, -TEMP_SUFFIX.length))) continue;
		const path = `${directory}/${filename}`;
		const info = await stat(path).catch(() => null);
		if (!info || Date.now() - info.mtimeMs < TEMP_GRACE_MS) continue;
		await unlink(path).catch(() => {});
		removed++;
		freed += info.size;
	}
	if (removed) {
		dcb.log(
			`Removed ${removed} orphaned temp cache file(s), freeing ${freed} bytes`,
		);
	}
	return removed;
}

export async function reviewCaches(streamIds: string[], forceReview = false) {
	// Before the size check below, so the reclaimed space counts and so stray
	// temps are collected even when the cache is nowhere near its limit
	await collectOrphanedTemps(streamIds);
	const maxSize = readSetting().MAX_CACHE_IN_GB * 1024 * 1024 * 1024;
	let size = await getFolderSize();
	if (size < maxSize && !forceReview) return;
	dcb.log(`Reviewing caches, cache size: ${size} / ${maxSize}`);
	const data = (
		await readFile(`${process.cwd()}/data/lastUsed.record`, "utf8")
	).split("\n");
	const actualCaches = readdirSync(`${process.cwd()}/cache`);
	const deletedFiles = [];
	for (const line of data) {
		const [id, lastUsedStr] = line.split("=");
		const lastUsed = Number(lastUsedStr);
		if (streamIds.includes(id)) continue; // do not delete if it is being streamed
		if (actualCaches.includes(`${id}.music`)) {
			const metadata = await stat(`${process.cwd()}/cache/${id}.music`);
			if (
				metadata.size === 0 ||
				(size >= maxSize &&
					!forceReview &&
					lastUsed < Date.now() - 1000 * 60 * 60 * 24)
			) {
				dcb.log(`Deleting cache: ${id}`);
				unlink(`${process.cwd()}/cache/${id}.music`).catch(() => {});
				size -= metadata.size;
				deletedFiles.push(id);
			}
		} else {
			deletedFiles.push(id);
		}
	}
	await updateLastUsed([], deletedFiles).catch(() => {});
}

export async function updateLastUsed(
	updateIds: string[],
	deleteIds?: string[],
) {
	const data = (
		await readFile(`${process.cwd()}/data/lastUsed.record`, "utf8")
	).split("\n");
	(() => {
		if (!updateIds.length) return;
		for (let i = 0; i < data.length; i++) {
			const line = data[i];
			for (const id of updateIds) {
				if (line.startsWith(id)) {
					data[i] = `${id}=${Date.now()}`;
					return;
				}
			}
		}
		data.push(`${updateIds}=${Date.now()}`);
	})();
	(() => {
		if (!deleteIds?.length) return;
		for (let i = 0; i < data.length; i++) {
			const line = data[i];
			for (const id of deleteIds) {
				if (line.startsWith(id)) {
					data.splice(i, 1);
					return;
				}
			}
		}
	})();
	return await writeFile(
		`${process.cwd()}/data/lastUsed.record`,
		data.join("\n"),
	);
}
