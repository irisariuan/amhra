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
	setting = JSON.parse(readFileSync(file, "utf8"));
	if (reloadLanguage) reloadLanguages();
	return setting;
}

export function writeJsonSync(file: string, data: Setting) {
	return writeFileSync(file, JSON.stringify(data, null, 4));
}

export type LogFile =
	| "errim"
	| "error"
	| "errwn"
	| "express"
	| "main"
	| "message";

export interface Setting {
	TOKEN: string;
	CLIENT_ID: string;

	TEST_CLIENT_ID: string;
	TESTING_TOKEN: string;

	OAUTH_TOKEN: string;
	AUTH_TOKEN: string;

	QUEUE_SIZE: number;
	HTTPS: boolean;
	PORT: number;
	RATE_LIMIT: number;
	REDIRECT_URI: string;
	WEBSITE?: null | string;

	PRELOAD: LogFile[];
	DETAIL_LOGGING: boolean;
	USE_YOUTUBE_DL: boolean;
	SEEK: boolean;
	AUTO_LEAVE: number;
	PREFIX: string;
	USE_COOKIES: boolean;
	MAX_CACHE_IN_GB: number;

	VOLUME_MODIFIER: number;
	BANNED_IDS: string[];
	MESSAGE_LOGGING: boolean;
	VOICE_LOGGING: boolean;
}
