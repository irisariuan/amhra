import { writeFileSync, readFileSync } from "node:fs";
import { reloadLanguages } from "./language";

let setting: Setting | null = null;

export function readSetting(
	file = `${process.cwd()}/data/setting.json`,
): Setting {
	if (setting === null) {
		setting = JSON.parse(readFileSync(file, "utf8"));
	}
	return setting ?? JSON.parse(readFileSync(file, "utf8"));
}

export function reloadSetting(
	reloadLanguage = true,
	file = `${process.cwd()}/data/setting.json`,
) {
	const nextSetting = JSON.parse(readFileSync(file, "utf8")) as Setting;
	// Modules commonly retain the object returned by readSetting(). Update that
	// object instead of replacing it so a runtime reload reaches those modules.
	if (setting) Object.assign(setting, nextSetting);
	else setting = nextSetting;
	if (reloadLanguage) reloadLanguages();
	return setting;
}

export function writeJsonSync(file: string, data: object) {
	return writeFileSync(file, JSON.stringify(data, null, 4));
}

export type LogFile = "errim" | "error" | "errwn" | "express" | "main";

/**
 * Everything the bot is configured with, except credentials.
 *
 * Tokens live in `.env` and are read through `lib/secrets.ts`: this file is
 * edited from the dashboard, served to it as a schema, and written by the setup
 * tools, so it is the wrong place for anything bearer-shaped.
 */
export interface Setting {
	CLIENT_ID: string;
	TEST_CLIENT_ID: string;

	QUEUE_SIZE: number;
	HTTPS: boolean;
	PORT: number;
	RATE_LIMIT: number;
	REDIRECT_URI: string;
	WEBSITE?: null | string;

	PRELOAD: LogFile[];
	DETAIL_LOGGING: boolean;
	USE_YOUTUBE_DL: boolean;
	/** Download through the Rust fetcher instead of yt-dlp */
	USE_NATIVE_FETCH?: boolean;
	/** Override the amhra-fetch binary path; defaults to the cargo build output */
	NATIVE_FETCH_BIN?: string;
	/** Play through the Rust voice sidecar instead of @discordjs/voice */
	USE_RUST_VOICE?: boolean;
	/** Override the amhra-sidecar binary path; defaults to the cargo build output */
	NATIVE_VOICE_BIN?: string;
	SEEK: boolean;
	AUTO_LEAVE: number;
	PREFIX: string;
	USE_COOKIES: boolean;
	MAX_CACHE_IN_GB: number;
	/** Seconds of already-played audio kept in memory for instant backward seek */
	MAX_REPLAY_BUFFER_IN_SEC?: number;
	/** Memory budget for not-yet-played audio; past it the cache file is re-read */
	MAX_STREAM_BUFFER_IN_MB?: number;

	VOLUME_MODIFIER: number;
	BANNED_IDS: string[];
	MESSAGE_LOGGING?: boolean;
	VOICE_LOGGING?: boolean;
}
