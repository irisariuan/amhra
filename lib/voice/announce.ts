import type { Phrase } from "../../rust/amhra-sidecar/bindings/protocol";
import { Language } from "../interaction";
import { languageText } from "../language";
import { MUSIC_COMMANDS, type VoiceIntent } from "./intent";

/**
 * What the bot says in the call when it acts on a voice command: "Skipping.",
 * "Playing bad guy.", "Volume 40 percent."
 *
 * The speech model reads English and Chinese, so a command in Chinese is
 * answered in Chinese and every other one in English. Most of what is said is
 * the same few phrases, which the sidecar is told about once (`prepared`) so
 * it can keep them ready; a song or a number makes a phrase it synthesises
 * when it is said.
 */

/** The language a command is answered aloud in, as the sidecar takes it. */
function spokenLanguage(language: Language) {
	return language === Language.TraditionalChinese
		? { language: Language.TraditionalChinese, code: "zh" }
		: { language: Language.English, code: "en" };
}

/** The phrase's id, and what fills it in, for what `intent` asks. */
function phrase(intent: VoiceIntent): [string, Record<string, string | number>?] {
	const options = intent.options ?? {};
	const toggled = (base: string) =>
		options.enabled === true ? `${base}_on` : options.enabled === false ? `${base}_off` : base;
	switch (intent.command) {
		case "play":
			return [options.next === true ? "voice_say_play_next" : "voice_say_play", { query: intent.query }];
		case "skip":
			return typeof options.amount === "number" && options.amount > 1
				? ["voice_say_skip_amount", { amount: options.amount }]
				: ["voice_say_skip"];
		case "loop":
		case "autoskipnonmusic":
			return [toggled(`voice_say_${intent.command}`)];
		case "remove":
			return typeof options.index === "number"
				? ["voice_say_remove", { index: options.index }]
				: ["voice_say_queue"];
		case "volume":
			return ["voice_say_volume", { volume: options.volume as number }];
		case "relocate":
			return ["voice_say_relocate", { position: options.position as string }];
		default:
			return [`voice_say_${intent.command}`];
	}
}

/** What to say for `intent`, and the language to say it in. */
export function announcement(intent: VoiceIntent): Phrase {
	const { language, code } = spokenLanguage(intent.language);
	const [id, replace] = phrase(intent);
	return { text: languageText(id, language, replace), language: code };
}

/** Every phrase that is always the same, in each language it is spoken in. */
export function prepared(): Phrase[] {
	const ids = new Set<string>();
	for (const command of MUSIC_COMMANDS) {
		const base = `voice_say_${command}`;
		ids.add(base);
		if (command === "loop" || command === "autoskipnonmusic") {
			ids.add(`${base}_on`);
			ids.add(`${base}_off`);
		}
	}
	const phrases: Phrase[] = [];
	for (const language of [Language.English, Language.TraditionalChinese]) {
		const { code } = spokenLanguage(language);
		for (const id of ids) {
			const text = languageText(id, language);
			if (text && !text.includes("{")) phrases.push({ text, language: code });
		}
	}
	return phrases;
}
