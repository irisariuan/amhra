import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * A JSON file of choices keyed by id, for what guilds and users pick for
 * themselves, as opposed to `data/setting.json`, which the bot's owner sets
 * for everyone at once.
 *
 * A file rather than the database: it is a handful of switches each, and
 * voice commands should not stop working because Postgres is down.
 */
export function settingStore<T extends object>(defaultFile: string) {
	let loaded: { file: string; entries: Record<string, T> } | null = null;

	function entries(file: string) {
		if (loaded?.file !== file) {
			loaded = {
				file,
				entries: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {},
			};
		}
		return loaded.entries;
	}

	return {
		get(id: string, file = defaultFile): Partial<T> {
			return entries(file)[id] ?? {};
		},
		set(id: string, change: Partial<T>, file = defaultFile): Partial<T> {
			const all = entries(file);
			const next = { ...all[id], ...change } as T;
			all[id] = next;
			// Written aside and renamed, so a crash mid-write cannot leave
			// everyone's choices unreadable.
			writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 4));
			renameSync(`${file}.tmp`, file);
			return next;
		},
	};
}
