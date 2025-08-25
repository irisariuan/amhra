import { Language } from "./interaction";

const languages: Record<Language, Record<string, string> | null> = {
	en: loadLanguage(Language.English),
	ja: loadLanguage(Language.Japanese),
	zhTw: loadLanguage(Language.TraditionalChinese),
	unsupported: null,
};

function loadLanguage(lang: Language): Record<string, string> {
	return {};
}

export function languageText(id: string, language: Language) {
	return id;
}
