import { describe, expect, test } from "bun:test";
import { ComponentType } from "discord.js";
import { Language } from "../lib/interaction";
import { languageText } from "../lib/language";
import {
	afterClick,
	type LanguageChoice,
	panelComponents,
	panelContent,
} from "../lib/voice/voiceLanguagePanel";
import { VOICE_LANGUAGES, type VoiceLanguage } from "../lib/voice/voiceSetting";

/** The ids of everything on the panel, as Discord would be sent them. */
function shown(choice: LanguageChoice, language = Language.English) {
	const rows = panelComponents(choice, language).map((row) => row.toJSON());
	return { rows, parts: rows.flatMap((row) => row.components) };
}
const idOf = (part: { custom_id?: string }) => part.custom_id ?? "";

describe("clicking", () => {
	const speaks: VoiceLanguage[] = ["en", "yue", "zh"];

	test("adding puts it last, and only once", () => {
		expect(afterClick({ speaks: [] }, "voice-language-add", ["yue"]).speaks).toEqual(["yue"]);
		expect(afterClick({ speaks }, "voice-language-add", ["ja"]).speaks).toEqual(["en", "yue", "zh", "ja"]);
		expect(afterClick({ speaks }, "voice-language-add", ["yue"]).speaks).toEqual(speaks);
		expect(afterClick({ speaks }, "voice-language-add", ["xx"]).speaks).toEqual(speaks);
	});

	test("up swaps it with the one above", () => {
		expect(afterClick({ speaks }, "voice-language-up:zh").speaks).toEqual(["en", "zh", "yue"]);
		expect(afterClick({ speaks }, "voice-language-up:yue").speaks).toEqual(["yue", "en", "zh"]);
		expect(afterClick({ speaks }, "voice-language-up:en").speaks).toEqual(speaks);
		expect(afterClick({ speaks }, "voice-language-up:ko").speaks).toEqual(speaks);
	});

	test("remove and clear leave the answer language alone", () => {
		const choice: LanguageChoice = { speaks, answers: "ja" };
		expect(afterClick(choice, "voice-language-remove:yue")).toEqual({ speaks: ["en", "zh"], answers: "ja" });
		expect(afterClick(choice, "voice-language-clear")).toEqual({ speaks: [], answers: "ja" });
	});

	test("the answer language is one of them, or the one heard", () => {
		expect(afterClick({ speaks }, "voice-language-output", ["yue"]).answers).toBe("yue");
		expect(afterClick({ speaks, answers: "yue" }, "voice-language-output", ["heard"]).answers).toBeUndefined();
		expect(afterClick({ speaks }, "voice-language-output", ["yue"]).speaks).toEqual(speaks);
	});

	test("every id on the panel does what it says", () => {
		const { parts } = shown({ speaks: ["en", "ko"] });
		const ids = parts.map(idOf);
		expect(ids).toContain("voice-language-up:ko");
		expect(ids).not.toContain("voice-language-up:en");
		expect(ids).toContain("voice-language-remove:en");
		expect(afterClick({ speaks: ["en", "ko"] }, "voice-language-up:ko").speaks).toEqual(["ko", "en"]);
	});
});

describe("what Discord is sent", () => {
	const lists: VoiceLanguage[][] = [[], ["en"], ["en", "yue"], ["en", "yue", "zh", "ja"], ["en", "yue", "zh", "ja", "ko"]];
	const languages = [Language.English, Language.Japanese, Language.Korean, Language.TraditionalChinese];

	// toJSON is where the builders hold labels and counts to Discord's limits.
	for (const speaks of lists) {
		test(`is within its limits with ${speaks.length} listed`, () => {
			for (const language of languages) {
				const { rows, parts } = shown({ speaks, answers: "yue" }, language);
				expect(rows.length).toBeLessThanOrEqual(5);
				for (const row of rows) {
					expect(row.components.length).toBeGreaterThan(0);
					expect(row.components.length).toBeLessThanOrEqual(5);
				}
				const ids = parts.map(idOf);
				expect(new Set(ids).size).toBe(ids.length);
			}
		});
	}

	test("offers only what is not listed yet, and nothing to add when all are", () => {
		const add = (speaks: VoiceLanguage[]) =>
			shown({ speaks }).parts.find((part) => idOf(part) === "voice-language-add");
		const menu = add(["en"]);
		expect(menu?.type).toBe(ComponentType.StringSelect);
		const values = (menu as unknown as { options: { value: string }[] }).options.map((option) => option.value);
		expect(values).toEqual(["zh", "yue", "ja", "ko"]);
		expect(add(["en", "yue", "zh", "ja", "ko"])).toBeUndefined();
	});

	test("shows the answer language chosen", () => {
		const output = shown({ speaks: [], answers: "yue" }).parts.find((part) => idOf(part) === "voice-language-output");
		const options = (output as unknown as { options: { value: string; default?: boolean }[] }).options;
		expect(options.filter((option) => option.default).map((option) => option.value)).toEqual(["yue"]);
		const none = shown({ speaks: [] }).parts.find((part) => idOf(part) === "voice-language-output");
		const heard = (none as unknown as { options: { value: string; default?: boolean }[] }).options;
		expect(heard.filter((option) => option.default).map((option) => option.value)).toEqual(["heard"]);
	});

	test("says the order, and when the recogniser cannot be told", () => {
		const content = panelContent({ speaks: ["en", "yue"], answers: "ja" }, Language.English, true);
		expect(content).toContain(`${VOICE_LANGUAGES.en} > ${VOICE_LANGUAGES.yue}`);
		expect(content).toContain(VOICE_LANGUAGES.ja);
		expect(panelContent({ speaks: ["en"] }, Language.English, false)).toContain(
			languageText("voice_language_input_guesses", Language.English, { language: VOICE_LANGUAGES.en }),
		);
	});

	test("every wording is there in every language", () => {
		for (const language of languages) {
			for (const id of ["add", "output_pick", "output_heard", "clear", "done"]) {
				expect(languageText(`voice_language_${id}`, language)).toBeTruthy();
			}
		}
	});
});
