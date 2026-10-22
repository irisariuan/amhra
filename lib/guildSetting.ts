import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * What each guild has chosen for itself, as opposed to `data/setting.json`,
 * which the bot's owner sets for every guild at once.
 *
 * A JSON file rather than the database: it is a handful of switches per
 * guild, and voice commands should not stop working because Postgres is down.
 */
export interface GuildSetting {
	/** Listen for the bot's name in this guild's voice channels. */
	voiceCommands?: boolean;
}

const DEFAULT_FILE = `${process.cwd()}/data/guildSetting.json`;

let loaded: { file: string; guilds: Record<string, GuildSetting> } | null = null;

function guilds(file: string) {
	if (loaded?.file !== file) {
		loaded = {
			file,
			guilds: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {},
		};
	}
	return loaded.guilds;
}

export function guildSetting(guildId: string, file = DEFAULT_FILE): GuildSetting {
	return guilds(file)[guildId] ?? {};
}

export function setGuildSetting(
	guildId: string,
	change: GuildSetting,
	file = DEFAULT_FILE,
): GuildSetting {
	const all = guilds(file);
	const next = { ...all[guildId], ...change };
	all[guildId] = next;
	// Written aside and renamed, so a crash mid-write cannot leave every
	// guild's choices unreadable.
	writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 4));
	renameSync(`${file}.tmp`, file);
	return next;
}
