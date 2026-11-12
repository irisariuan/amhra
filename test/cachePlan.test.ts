import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	dropCached,
	markUsed,
	migrateLastUsedRecord,
	reviewCaches,
} from "../lib/voice/cache";
import {
	type CacheFile,
	parseCacheName,
	planCacheReview,
	TEMP_GRACE_MS,
	USE_GRACE_MS,
} from "../lib/voice/cachePlan";

/**
 * What a cache review deletes. Each case is something the old record-file
 * review got wrong or could not see.
 */

const now = 10_000_000_000;
const HOUR = 60 * 60 * 1000;

function file(name: string, size: number, ageMs: number): CacheFile {
	return { name, size, mtimeMs: now - ageMs };
}

function plan(files: CacheFile[], maxBytes: number, activeIds: string[] = []) {
	return planCacheReview(files, { maxBytes, now, activeIds });
}

describe("cache file names", () => {
	test("tell a temp file from a finished one", () => {
		expect(parseCacheName("abc.music")).toEqual({ id: "abc", kind: "music" });
		expect(parseCacheName("abc.temp.music")).toEqual({
			id: "abc",
			kind: "tempMusic",
		});
		expect(parseCacheName("abc.idx")).toEqual({ id: "abc", kind: "index" });
		expect(parseCacheName("abc.temp.idx")).toEqual({
			id: "abc",
			kind: "tempIndex",
		});
	});

	test("ignore files that are not part of the cache", () => {
		expect(parseCacheName(".gitkeep")).toBeNull();
		expect(parseCacheName(".music")).toBeNull();
	});
});

describe("eviction", () => {
	test("does nothing while the cache fits", () => {
		const result = plan([file("a.music", 40, HOUR), file("b.music", 60, HOUR)], 100);
		expect(result.remove).toEqual([]);
		expect(result.totalBytes).toBe(100);
	});

	test("removes the least recently used first, and only as much as needed", () => {
		const result = plan(
			[
				file("new.music", 50, 1 * HOUR),
				file("old.music", 50, 3 * HOUR),
				file("mid.music", 50, 2 * HOUR),
			],
			100,
		);
		expect(result.remove).toEqual(["old.music"]);
		expect(result.freedBytes).toBe(50);
	});

	test("takes a track's index with it", () => {
		const result = plan(
			[
				file("old.music", 90, 3 * HOUR),
				file("old.idx", 10, 3 * HOUR),
				file("new.music", 90, HOUR),
			],
			100,
		);
		expect(result.remove).toEqual(["old.music", "old.idx"]);
	});

	test("counts temp and index files towards the budget", () => {
		const result = plan(
			[
				file("a.music", 60, HOUR),
				file("a.idx", 20, HOUR),
				file("b.temp.music", 30, 0),
			],
			100,
		);
		expect(result.totalBytes).toBe(110);
		expect(result.remove).toEqual(["a.music", "a.idx"]);
	});

	test("leaves a track that was only just used, even over budget", () => {
		const result = plan([file("playing.music", 500, USE_GRACE_MS - 1)], 100);
		expect(result.remove).toEqual([]);
	});

	test("leaves a track that is being downloaded again", () => {
		const result = plan(
			[file("a.music", 80, 2 * HOUR), file("b.music", 80, HOUR)],
			100,
			["a"],
		);
		expect(result.remove).toEqual(["b.music"]);
	});

	test("reaches tracks nothing ever recorded a use for", () => {
		// The old review only looked at ids listed in lastUsed.record
		const result = plan([file("stray.music", 500, 30 * 24 * HOUR)], 100);
		expect(result.remove).toEqual(["stray.music"]);
	});
});

describe("leftovers", () => {
	test("removes a temp file no download owns", () => {
		const result = plan(
			[
				file("dead.temp.music", 10, TEMP_GRACE_MS),
				file("dead.temp.idx", 1, TEMP_GRACE_MS),
			],
			1000,
		);
		expect(result.remove).toEqual(["dead.temp.music", "dead.temp.idx"]);
	});

	test("keeps a temp file that is fresh or has a download behind it", () => {
		expect(plan([file("a.temp.music", 10, 1000)], 1000).remove).toEqual([]);
		expect(
			plan([file("a.temp.music", 10, HOUR)], 1000, ["a"]).remove,
		).toEqual([]);
	});

	test("removes an empty track, which would otherwise be served as one", () => {
		const result = plan(
			[file("empty.music", 0, 0), file("empty.idx", 4, 0)],
			1000,
		);
		expect(result.remove).toEqual(["empty.music", "empty.idx"]);
	});

	test("removes an index whose audio is gone", () => {
		expect(plan([file("gone.idx", 4, HOUR)], 1000).remove).toEqual(["gone.idx"]);
	});

	test("keeps an index whose audio is still arriving", () => {
		expect(
			plan([file("a.idx", 4, HOUR), file("a.temp.music", 10, 0)], 1000).remove,
		).toEqual([]);
		expect(plan([file("a.idx", 4, 1000)], 1000).remove).toEqual([]);
	});
});

describe("on disk", () => {
	async function scratch() {
		return mkdtemp(join(tmpdir(), "amhra-cache-"));
	}
	async function put(dir: string, name: string, size: number, ageMs: number) {
		await writeFile(join(dir, name), Buffer.alloc(size));
		const time = new Date(Date.now() - ageMs);
		await utimes(join(dir, name), time, time);
	}

	test("a review evicts down to the limit and spares what was just used", async () => {
		const dir = await scratch();
		await put(dir, "old.music", 60, 3 * HOUR);
		await put(dir, "old.idx", 5, 3 * HOUR);
		await put(dir, "mid.music", 60, 2 * HOUR);
		await put(dir, "new.music", 60, HOUR);
		await put(dir, ".gitkeep", 0, 99 * HOUR);

		// Using the oldest makes it the newest
		await markUsed("old", dir);
		await reviewCaches([], dir, 130);

		expect((await readdir(dir)).sort()).toEqual([
			".gitkeep",
			"new.music",
			"old.idx",
			"old.music",
		]);
	});

	test("dropping a track removes its index too", async () => {
		const dir = await scratch();
		await put(dir, "a.music", 10, 0);
		await put(dir, "a.idx", 1, 0);
		await dropCached("a", dir);
		expect(await readdir(dir)).toEqual([]);
	});

	test("the old record file becomes file times, then goes away", async () => {
		const dir = await scratch();
		await put(dir, "abc.music", 10, 0);
		const record = join(dir, "lastUsed.record");
		const used = Date.now() - 5 * HOUR;
		await writeFile(record, `\nabc=${used}\nmissing=${used}\nbroken`);

		await migrateLastUsedRecord(record, dir);

		const info = await stat(join(dir, "abc.music"));
		expect(Math.abs(info.mtimeMs - used)).toBeLessThan(1000);
		expect(await readdir(dir)).toEqual(["abc.music"]);
	});
});
