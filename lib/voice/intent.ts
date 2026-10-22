import { Language } from "../interaction";
import { languageCommandName } from "../language";

/**
 * What someone asked for after saying the bot's name, when no model reads it
 * (see `intentModel.ts`): a command's own name, said near the start.
 *
 * The names are the slash commands' — "skip", "pause", "play", and each
 * language's own ("スキップ", "일시정지", "暫停") — so there is no list of
 * words to keep. It is deliberately plain. Before the name there may be up to
 * two words of whatever the recogniser made of the bot's name ("Ehara,
 * skip"); after it, nothing for "play" means carry on, and anything else is
 * the song to play. It understands nothing the recogniser garbles, and it
 * takes "stop talking" for stop: it is the fallback for when the model is
 * not there.
 */

export const VOICE_COMMANDS = [
	"play",
	"pause",
	"resume",
	"skip",
	"skipnonmusic",
	"stop",
	"disconnect",
] as const;
export type VoiceCommandName = (typeof VOICE_COMMANDS)[number];

/**
 * Every command about the music, which a model reading the command may
 * choose from. The fallback here knows only `VOICE_COMMANDS`.
 */
export const MUSIC_COMMANDS = [
	...VOICE_COMMANDS,
	"autoskipnonmusic",
	"join",
	"loop",
	"queue",
	"nowplaying",
	"remove",
	"volume",
	"lyrics",
	"relocate",
] as const;
export type MusicCommandName = (typeof MUSIC_COMMANDS)[number];

/** Values for a command's options, under the slash command's own names. */
export type VoiceOptions = Record<string, string | number | boolean>;

export type VoiceIntent =
	| { command: Exclude<MusicCommandName, "play">; language: Language; options?: VoiceOptions }
	| { command: "play"; query: string; language: Language; options?: VoiceOptions };

/** The languages the recogniser reports, as the bot's own. */
const RECOGNISER_LANGUAGES: Record<string, Language> = {
	en: Language.English,
	ja: Language.Japanese,
	ko: Language.Korean,
	zh: Language.TraditionalChinese,
	yue: Language.TraditionalChinese,
};

/** The bot's language for one the recogniser reported, if it has one. */
export function recogniserLanguage(lang: string | null): Language | undefined {
	return lang ? RECOGNISER_LANGUAGES[lang] : undefined;
}

const LANGUAGES = [
	Language.English,
	Language.Japanese,
	Language.Korean,
	Language.TraditionalChinese,
];

/** Words of the bot's name, however written, allowed before the command. */
const LEAD_WORDS = 2;

/** Lower case, without punctuation or spaces: how names are compared. */
function squash(text: string) {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\p{P}\p{S}\s]/gu, "");
}

type Name = { command: VoiceCommandName; name: string; language: Language };

/** Every name each command goes by, longest first so "skip" waits its turn. */
function names(): Name[] {
	const found: Name[] = [];
	for (const command of VOICE_COMMANDS) {
		found.push({ command, name: squash(command), language: Language.English });
		for (const language of LANGUAGES) {
			const localised = languageCommandName(command, language)?.name;
			if (localised) found.push({ command, name: squash(localised), language });
		}
	}
	return found.sort((a, b) => b.name.length - a.name.length);
}

/**
 * Read a command out of what was heard. `lang` is what the recogniser thought
 * the language was; it decides the language of the answer when the name is
 * the same in several, as "play" is.
 */
export function parseVoiceCommand(text: string, lang: string | null): VoiceIntent | null {
	const words = text
		.normalize("NFKC")
		.split(/[\s,，、。.!?！？]+/u)
		.filter((word) => squash(word));
	for (let start = 0; start <= Math.min(LEAD_WORDS, words.length - 1); start++) {
		const rest = squash(words.slice(start).join(""));
		// Where words end, so "stopped" is not stop and "player" not play. A
		// name in a script written without spaces may run on into the rest.
		const ends = new Set<number>();
		let length = 0;
		for (const word of words.slice(start)) ends.add((length += squash(word).length));
		const name = names().find(
			(candidate) =>
				rest.startsWith(candidate.name) &&
				(ends.has(candidate.name.length) || !/^[a-z]+$/.test(candidate.name)),
		);
		if (!name) continue;
		const language =
			name.language === Language.English
				? (recogniserLanguage(lang) ?? Language.English)
				: name.language;
		if (name.command !== "play") return { command: name.command, language };
		const query = songAfter(words.slice(start), name.name);
		return query ? { command: "play", query, language } : { command: "resume", language };
	}
	return null;
}

/** What follows the name "play" in `words`, as it was written. */
function songAfter(words: string[], name: string) {
	// The name may run across words or be the start of one ("播放晴天", in a
	// language written without spaces).
	let taken = "";
	for (let index = 0; index < words.length; index++) {
		const word = words[index];
		const needed = name.slice(taken.length);
		const squashed = squash(word);
		if (needed.startsWith(squashed)) {
			taken += squashed;
			if (taken === name) return words.slice(index + 1).join(" ").trim();
			continue;
		}
		if (squashed.startsWith(needed)) {
			const characters = [...word];
			let cut = 0;
			while (taken !== name && cut < characters.length) {
				taken += squash(characters[cut]);
				cut++;
			}
			return [characters.slice(cut).join(""), ...words.slice(index + 1)].join(" ").trim();
		}
		return "";
	}
	return "";
}
