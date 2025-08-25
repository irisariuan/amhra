import { readFileSync } from "node:fs";
import { Language } from "./interaction";
import { join } from "node:path";
import { Locale } from "discord.js";

export function reloadLanguages() {
	for (const lang of Object.values(Language)) {
		if (lang !== Language.Unsupported) {
			languages[lang] = loadLanguage(lang);
		}
	}
}

let languages = {
	en: loadLanguage(Language.English),
	ja: loadLanguage(Language.Japanese),
	zhTw: loadLanguage(Language.TraditionalChinese),
	unsupported: null,
};

export interface CommandLocale {
	name?: string;
	description?: string;
	options?: Record<string, CommandLocale>;
}

function loadLanguage(
	lang: Language,
): { commands: Record<string, CommandLocale> } & Record<string, string> {
	return JSON.parse(
		readFileSync(
			join(process.cwd(), "data", "lang", `${lang}.json`),
			"utf8",
		),
	);
}

export function languageText(
	id: string,
	language: Language,
	replace?: Record<string, string | number>,
	fallback?: string,
) {
	const processedId = id.trim().toUpperCase();
	const base =
		languages[language]?.[processedId] ??
		languages[Language.English]?.[processedId];
	if (base) {
		if (replace) {
			let result = base;
			for (const [key, value] of Object.entries(replace)) {
				result = result.replaceAll(`{${key}}`, value.toString());
			}
			return result;
		}
		return base;
	}
	return fallback ?? id;
}

export function languageCommandName(
	name: string,
	language: Language,
	isContextCommand = false,
) {
	return (
		languages[language]?.commands[isContextCommand ? `{${name}}` : name] ??
		null
	);
}

export function parseLanguageToLocale(language: Language): Locale {
	switch (language) {
		case Language.English:
			return Locale.EnglishUS;
		case Language.Japanese:
			return Locale.Japanese;
		case Language.TraditionalChinese:
			return Locale.ChineseTW;
		default:
			return Locale.EnglishUS;
	}
}
