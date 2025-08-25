import { readFileSync } from "node:fs";
import { Language } from "./interaction";
import { join } from "node:path";

export function reloadLanguages() {
	for (const lang of Object.values(Language)) {
		if (lang !== Language.Unsupported) {
			languages[lang] = loadLanguage(lang);
		}
	}
}

let languages: Record<Language, Record<string, string> | null> = {
	en: loadLanguage(Language.English),
	ja: loadLanguage(Language.Japanese),
	zhTw: loadLanguage(Language.TraditionalChinese),
	unsupported: null,
};

function loadLanguage(lang: Language): Record<string, string> {
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
