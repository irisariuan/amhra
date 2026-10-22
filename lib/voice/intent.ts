import { Language } from "../interaction";
import { languageVoice, type VoiceVocabulary } from "../language";

/**
 * What someone asked for after saying the bot's name.
 *
 * The sidecar hands over text, not a command, and the text is rough. The live
 * test of the trained wake model produced "how, I pay this song" for "play
 * this song", "Em, I pre the song" for "pause the song" and "And how ski this
 * on." for "skip this song". So this is forgiving about the words and strict
 * about the shape: a verb has to lead, after nothing but what is left of the
 * name and a few fillers, and only words that could describe the current song
 * may follow it. That shape is what keeps chatter after a false wake ("I'm
 * going to stop by later") from becoming a command.
 *
 * The words themselves live in each language's file, under `voice`:
 *
 * - `words`: the language is matched word by word (English). Otherwise it is
 *   matched character by character with spaces ignored, which suits Japanese
 *   and Chinese and, with particles stripped, Korean.
 * - `wake`: how the name, or its tail, comes out at the start of the text.
 *   In the character languages, nothing one character long: it would be
 *   stripped off the front of a word ("음" from "음악").
 * - `fillers`: words allowed between the name and the verb ("please").
 * - `particles`: grammar around the object ("を", "를", "吧"), stripped from
 *   what is left once the verb is found. Character languages only.
 * - `suffixes`: endings after a verb ("して", "해줘"), character languages only.
 * - `current`: words that mean the song already playing ("this song"). After
 *   any verb but play they are all that may follow; after play they turn a
 *   request into a resume.
 * - `fuzzy`: commands whose verbs may be matched a letter or two off, words
 *   languages only.
 * - `verbs`: each command's phrases, misheard forms included.
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
 * choose from (see `intentModel.ts`). The word matching knows only
 * `VOICE_COMMANDS`.
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

/** Every language with a vocabulary, the reported one first. */
const ALL_LANGUAGES = [
	Language.English,
	Language.Japanese,
	Language.Korean,
	Language.TraditionalChinese,
];

/** At most this many words of leftover name before the verb. */
const MAX_LEAD_WORDS = 3;
/** The name the bot answers to, as the recogniser might spell it. */
const NAME_FORMS = ["amhra", "amhara", "emhara"];

/**
 * Read a command out of what was heard. `lang` is what the recogniser thought
 * the language was; it is tried first, then the rest, because short windows are
 * sometimes taken for the wrong one.
 */
export function parseVoiceCommand(
	text: string,
	lang: string | null,
	vocabularyOf: (language: Language) => VoiceVocabulary | null = languageVoice,
): VoiceIntent | null {
	const reported = recogniserLanguage(lang);
	const order = reported
		? [reported, ...ALL_LANGUAGES.filter((language) => language !== reported)]
		: ALL_LANGUAGES;
	for (const language of order) {
		const vocabulary = vocabularyOf(language);
		if (!vocabulary) continue;
		const found = vocabulary.words
			? parseWords(text, vocabulary)
			: parseCharacters(text, vocabulary);
		if (found) return { ...found, language } as VoiceIntent;
	}
	return null;
}

type Found =
	| { command: Exclude<VoiceCommandName, "play"> }
	| { command: "play"; query: string };

/** Play with nothing new to play means carry on with what is there. */
function settle(command: VoiceCommandName, query: string | null): Found {
	if (command !== "play") return { command };
	return query ? { command, query } : { command: "resume" };
}

function isCommand(name: string): name is VoiceCommandName {
	return (VOICE_COMMANDS as readonly string[]).includes(name);
}

// --- Word by word -----------------------------------------------------------

interface Word {
	/** As written, for a song request. */
	original: string;
	/** Lower case, letters and digits only. */
	plain: string;
	/** A comma (or full stop) came straight after it. */
	pause: boolean;
}

function words(text: string): Word[] {
	return text
		.normalize("NFKC")
		.split(/\s+/)
		.map((original) => ({
			original,
			plain: original.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""),
			pause: /[,.，、。]$/.test(original),
		}))
		.filter((word) => word.plain);
}

function parseWords(text: string, vocabulary: VoiceVocabulary): Found | null {
	const heard = words(text);
	const lead = new Set([...vocabulary.wake, ...vocabulary.fillers].map(plain));
	const current = new Set(vocabulary.current.map(plain));

	// The verb may start after up to a few words of leftover name. Each word
	// skipped has to be one: a known form of the name, a filler, or anything
	// at all before the comma the recogniser puts after a name it heard.
	for (let start = 0; start <= Math.min(MAX_LEAD_WORDS, heard.length - 1); start++) {
		const skipped = heard.slice(0, start);
		const pausedAfter = skipped.findLastIndex((word) => word.pause);
		const leftover = skipped.every(
			(word, index) =>
				index <= pausedAfter || lead.has(word.plain) || nameLike(word.plain),
		);
		if (!leftover) break;

		const verb = matchVerb(heard, start, vocabulary);
		if (!verb) continue;
		const rest = heard.slice(start + verb.length);
		const describesCurrent = rest.every((word) => current.has(word.plain));

		if (verb.command === "play") {
			if (describesCurrent) return settle("play", null);
			// A search plays something new, which a mishearing should not do:
			// "pay me back" is not a request for a song called "me back".
			if (verb.distance > 0) return null;
			return settle("play", query(rest));
		}
		return describesCurrent ? settle(verb.command, null) : null;
	}
	return null;
}

function plain(word: string) {
	return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** A word that is probably the name itself, spelled some new way. */
function nameLike(word: string) {
	return (
		word.length >= 4 &&
		NAME_FORMS.some((name) => levenshtein(word, name) <= 2)
	);
}

/** The query as it was written, without punctuation at either end. */
function query(rest: Word[]) {
	const text = rest
		.map((word) => word.original)
		.join(" ")
		.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "");
	return text || null;
}

/**
 * The best verb phrase starting at `start`: the longest, then the closest.
 * Two commands equally close is a mishearing that could go either way, and
 * that is no match at all.
 */
function matchVerb(heard: Word[], start: number, vocabulary: VoiceVocabulary) {
	const fuzzy = new Set(vocabulary.fuzzy ?? []);
	let best: { command: VoiceCommandName; length: number; distance: number } | null =
		null;
	let tied = false;

	for (const [command, phrases] of Object.entries(vocabulary.verbs)) {
		if (!isCommand(command)) continue;
		for (const phrase of phrases) {
			const parts = phrase.split(/\s+/).map(plain);
			if (start + parts.length > heard.length) continue;
			let distance = 0;
			for (const [index, part] of parts.entries()) {
				const off = wordDistance(heard[start + index].plain, part, fuzzy.has(command));
				if (off === null) {
					distance = Number.POSITIVE_INFINITY;
					break;
				}
				distance += off;
			}
			if (!Number.isFinite(distance)) continue;

			const better =
				!best ||
				parts.length > best.length ||
				(parts.length === best.length && distance < best.distance);
			const same =
				best && parts.length === best.length && distance === best.distance;
			if (better) {
				best = { command, length: parts.length, distance };
				tied = false;
			} else if (same && best && best.command !== command) {
				tied = true;
			}
		}
	}
	return best && !tied ? best : null;
}

/**
 * How far `heard` is from `verb`, or null if too far. A mishearing keeps the
 * first sound and changes little else: "pay" for "play", "ski" for "skip".
 */
function wordDistance(heard: string, verb: string, fuzzy: boolean) {
	if (heard === verb) return 0;
	if (!fuzzy || heard.length < 3 || verb.length < 3 || heard[0] !== verb[0]) {
		return null;
	}
	const distance = levenshtein(heard, verb);
	return distance <= (verb.length >= 6 ? 2 : 1) ? distance : null;
}

export function levenshtein(a: string, b: string) {
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			row[j] = Math.min(
				previous[j] + 1,
				row[j - 1] + 1,
				previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		previous = row;
	}
	return previous[b.length];
}

// --- Character by character -------------------------------------------------

interface Characters {
	/** The text without spaces or punctuation. */
	text: string;
	/** Where each of those characters sat in the original. */
	at: number[];
	/** Offsets in `text` that came straight after a comma or full stop. */
	pauses: number[];
}

function characters(original: string): Characters {
	const result: Characters = { text: "", at: [], pauses: [] };
	for (const [index, char] of [...original].entries()) {
		if (/[\p{L}\p{N}]/u.test(char)) {
			result.text += char;
			result.at.push(index);
		} else if (/[,.，、。]/.test(char) && result.text) {
			result.pauses.push(result.text.length);
		}
	}
	return result;
}

function parseCharacters(text: string, vocabulary: VoiceVocabulary): Found | null {
	const original = [...text.normalize("NFKC")];
	const heard = characters(original.join(""));
	// The name often comes out in Latin letters ahead of the command, and
	// nothing in Latin letters before a Japanese, Korean or Chinese command
	// is anything else.
	const latin = /^[a-z]+/i.exec(heard.text)?.[0].length ?? 0;
	const starts = [latin, ...heard.pauses.filter((at) => at > latin && at <= latin + 6)];

	for (const start of starts) {
		const found = parseFrom(heard, start, original, vocabulary);
		if (found) return found;
	}
	return null;
}

function parseFrom(
	heard: Characters,
	start: number,
	original: string[],
	vocabulary: VoiceVocabulary,
): Found | null {
	const lead = longestFirst([...vocabulary.wake, ...vocabulary.fillers]);
	const particles = longestFirst(vocabulary.particles ?? []);
	const suffixes = longestFirst(vocabulary.suffixes ?? []);
	const around = longestFirst([
		...vocabulary.fillers,
		...(vocabulary.particles ?? []),
		...(vocabulary.suffixes ?? []),
	]);
	const current = new Set(vocabulary.current);
	const verbs = Object.entries(vocabulary.verbs)
		.filter(([command]) => isCommand(command))
		.flatMap(([command, phrases]) =>
			phrases.map((phrase) => ({
				command: command as VoiceCommandName,
				phrase: phrase.replace(/\s+/g, ""),
			})),
		)
		.sort((a, b) => b.phrase.length - a.phrase.length);

	const to = heard.text.length;
	const from = stripStart(heard.text, start, to, lead);
	if (from >= to) return null;

	const candidates: {
		command: VoiceCommandName;
		rest: [number, number];
		verbFirst: boolean;
	}[] = [];
	// Verb first, as in Chinese and English-shaped Korean: "跳过这首歌".
	const first = verbs.find(({ phrase }) => heard.text.startsWith(phrase, from));
	if (first) {
		candidates.push({
			command: first.command,
			rest: [from + first.phrase.length, to],
			verbFirst: true,
		});
	}
	// Verb last, as in Japanese and Korean: "この曲をスキップして".
	const end = stripEnd(heard.text, from, to, suffixes);
	const last = verbs.find(
		({ phrase }) =>
			end - phrase.length >= from && heard.text.startsWith(phrase, end - phrase.length),
	);
	if (last) {
		candidates.push({
			command: last.command,
			rest: [from, end - last.phrase.length],
			verbFirst: false,
		});
	}

	for (const { command, rest, verbFirst } of candidates) {
		const [restFrom, restTo] = rest;
		const looseFrom = stripStart(heard.text, restFrom, restTo, around);
		const remainder = heard.text.slice(
			looseFrom,
			stripEnd(heard.text, looseFrom, restTo, around),
		);
		if (!remainder || current.has(remainder)) return settle(command, null);
		if (command !== "play") continue;

		// A title can start or end with anything that looks like grammar, so
		// only what sits against the verb, or ends the sentence, is cut.
		const queryTo = stripEnd(
			heard.text,
			restFrom,
			restTo,
			verbFirst ? [...suffixes, ...particles] : particles,
		);
		if (queryTo <= restFrom) continue;
		// The request as it was said, spaces and all.
		const said = original
			.slice(heard.at[restFrom], heard.at[queryTo - 1] + 1)
			.join("")
			.trim();
		return settle(command, said);
	}
	return null;
}

function longestFirst(phrases: string[]) {
	return [...new Set(phrases.map((phrase) => phrase.replace(/\s+/g, "")))]
		.filter(Boolean)
		.sort((a, b) => b.length - a.length);
}

/** Skip any of `phrases` at `from`, repeatedly. */
function stripStart(text: string, from: number, to: number, phrases: string[]) {
	for (;;) {
		const found = phrases.find(
			(phrase) => from + phrase.length <= to && text.startsWith(phrase, from),
		);
		if (!found) return from;
		from += found.length;
	}
}

/** Skip any of `phrases` before `to`, repeatedly. */
function stripEnd(text: string, from: number, to: number, phrases: string[]) {
	for (;;) {
		const found = phrases.find(
			(phrase) =>
				to - phrase.length >= from && text.startsWith(phrase, to - phrase.length),
		);
		if (!found) return to;
		to -= found.length;
	}
}
