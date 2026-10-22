import type { Phrase } from "../../rust/amhra-sidecar/bindings/protocol";
import { Language } from "../interaction";
import { languageText } from "../language";
import { MUSIC_COMMANDS, type VoiceIntent } from "./intent";
import type { Found } from "./voiceInteraction";

/**
 * What the bot says in the call when it acts on a voice command: "Skipping.",
 * "Volume 40 percent.", and for play the title of what the search found,
 * "Playing Billie Eilish - bad guy.", once it has found it.
 *
 * A command is answered in the language it was given in: English, Japanese,
 * Korean or Chinese, the last in Cantonese when that is what was heard. The
 * sidecar has a voice for each (Supertonic, Kokoro for Mandarin, a Cantonese
 * one). Most of what is said is the same few phrases, which the sidecar is
 * told about once (`prepared`) so it can keep them ready; a song or a number
 * makes a phrase it synthesises when it is said.
 */

/**
 * The language a command is answered aloud in: the bot's, for the text, and
 * the sidecar's code, for the voice. `heard` is what the recogniser reported,
 * which tells Cantonese from Mandarin where the bot's language does not.
 */
function spokenLanguage(language: Language, heard?: string | null) {
	switch (language) {
		case Language.TraditionalChinese:
			return { language, code: heard === "yue" ? "yue" : "zh" };
		case Language.Japanese:
			return { language, code: "ja" };
		case Language.Korean:
			return { language, code: "ko" };
		default:
			return { language: Language.English, code: "en" };
	}
}

/** Every language and voice the bot answers aloud in. */
const SPOKEN: [Language, string | null][] = [
	[Language.English, null],
	[Language.Japanese, null],
	[Language.Korean, null],
	[Language.TraditionalChinese, "zh"],
	[Language.TraditionalChinese, "yue"],
];

/** The phrase's id, and what fills it in, for what `intent` asks. */
function phrase(intent: VoiceIntent): [string, Record<string, string | number>?] {
	const options = intent.options ?? {};
	const toggled = (base: string) =>
		options.enabled === true ? `${base}_on` : options.enabled === false ? `${base}_off` : base;
	switch (intent.command) {
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

/**
 * What to say as `intent` starts, and the language to say it in. Nothing for
 * play, which is said when its search has found something (`foundAnnouncement`).
 */
export function announcement(intent: VoiceIntent, heard?: string | null): Phrase | null {
	if (intent.command === "play") return null;
	const { language, code } = spokenLanguage(intent.language, heard);
	const [id, replace] = phrase(intent);
	return { text: languageText(id, language, replace), language: code };
}

/** What to say when a play command's search found `found`. */
export function foundAnnouncement(found: Found, language: Language, heard?: string | null): Phrase {
	const spoken = spokenLanguage(language, heard);
	const id = found.next ? "voice_say_play_next" : found.queued ? "voice_say_play_queued" : "voice_say_play";
	return { text: languageText(id, spoken.language, { title: spokenTitle(found.title) }), language: spoken.code };
}

/**
 * A video's title as it is worth saying: without what is in brackets ("(Official
 * Music Video)", "[MV]", "【中字】") or after a bar, unless that leaves nothing.
 */
export function spokenTitle(title: string) {
	const trimmed = title
		.replace(/\([^)]*\)|\[[^\]]*\]|【[^】]*】|（[^）]*）/gu, " ")
		.replace(/\s+[|｜].*$/u, "")
		.replace(/\s+/gu, " ")
		.replace(/[\s\-–—:,]+$/u, "")
		.trim();
	return trimmed || title.trim();
}

/** Every phrase that is always the same, in each language it is spoken in. */
export function prepared(): Phrase[] {
	const ids = new Set<string>();
	for (const command of MUSIC_COMMANDS) {
		const base = `voice_say_${command}`;
		if (command === "play") continue;
		ids.add(base);
		if (command === "loop" || command === "autoskipnonmusic") {
			ids.add(`${base}_on`);
			ids.add(`${base}_off`);
		}
	}
	const phrases: Phrase[] = [];
	for (const [bot, heard] of SPOKEN) {
		const { language, code } = spokenLanguage(bot, heard);
		for (const id of ids) {
			const text = languageText(id, language);
			if (text && !text.includes("{")) phrases.push({ text, language: code });
		}
	}
	return phrases;
}
