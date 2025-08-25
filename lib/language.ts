import { readFileSync } from "node:fs";
import { Language } from "./interaction";
import { join } from "node:path";
import { Locale } from "discord.js";
import { globalApp } from "./misc";

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
	ko: loadLanguage(Language.Korean),
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
	globalApp.warn(`Unknown label: ${id}`)
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
		case Language.Korean:
			return Locale.Korean;
		default:
			return Locale.EnglishUS;
	}
}

export function parseLocale(locale: Locale): Language {
	if (locale.startsWith("en")) return Language.English;
	if (locale === Locale.ChineseTW) return Language.TraditionalChinese;
	if (locale === Locale.Japanese) return Language.Japanese;
	if (locale === Locale.Korean) return Language.Korean;
	return Language.Unsupported;
}
