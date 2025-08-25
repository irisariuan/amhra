import { readdirSync } from "node:fs";
import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dcb } from "../misc";
import { readSetting } from "../setting";

export async function getFolderSize() {
	let totalSize = 0;
	for (const filename of await readdir(`${process.cwd()}/cache`)) {
		const { size } = await stat(`${process.cwd()}/cache/${filename}`);
		totalSize += size;
	}
	return totalSize;
}

export async function reviewCaches(streamIds: string[], forceReview = false) {
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
