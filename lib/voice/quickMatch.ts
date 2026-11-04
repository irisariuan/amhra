import { Language } from "../interaction";
import { languagePatterns, type VoicePatterns } from "../language";
import { recogniserLanguage } from "./intent";

/**
 * Commands said so plainly that no model has to read them: "play bad guy",
 * "skip", "次の曲", "晴天を再生して", "볼륨 40".
 *
 * Every phrase is data, under `voicePatterns` in `data/lang/*.json`, so a phrase
 * or a language is added there and nothing here changes. Each language has:
 *
 * - `commands`: for each command, what it is said as. `{name}` stands for that
 *   option of the command, wherever the language puts it ("{search}を再生して").
 * - `name`: how the bot's name comes out, for when the recogniser kept it.
 * - `polite`: words that change nothing at either end ("please").
 * - `defer` and `deferStarts`: words in, or at the start of, what fills a slot
 *   that mean more was asked than a plain search can do ("play it again", "play
 *   the live version"). Those go to the model.
 *
 * The whole of what was said has to fit a phrase, so anything unsure goes to the
 * model too: this only ever saves it work, and "I'll play football later" and
 * "stop talking" fit nothing here.
 */

/** A phrase that fits: the command and its options, as the model would say it. */
export type QuickMatch = { raw: Record<string, unknown>; language: Language };

const LANGUAGES = [Language.English, Language.Japanese, Language.Korean, Language.TraditionalChinese];

/** Punctuation between clauses: more than one thing may have been asked. */
const CLAUSES = /[,，、;；:：。!！?？]|\.\s/u;
/** How far a name written in letters can be misheard and still be the name. */
const NAME_DISTANCE = 2;
/** Names shorter than this could be any word. */
const NAME_LENGTH = 4;
/** Words a misheard name comes to at most. */
const NAME_WORDS = 2;

/**
 * Marks a recogniser puts around a title: Qwen3-ASR hears "播放《晴天》". The
 * search is for the title, not the marks.
 */
const TITLE_MARKS = /^[《〈「『"“]+|[》〉」』"”]+$/gu;

const LETTER = /\p{Script=Latin}$/u;
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const squash = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");

type Phrase = { command: string; regex: RegExp; slots: string[]; literal: number; language: Language };

/** A phrase as a regex over the whole of what was said. */
function compile(command: string, phrase: string, language: Language): Phrase {
	const parts = phrase.normalize("NFKC").split(/(\{\w+\})/).filter(Boolean);
	const slots: string[] = [];
	let source = "";
	let literal = 0;
	parts.forEach((part, index) => {
		const slot = /^\{(\w+)\}$/.exec(part);
		if (slot?.[1]) {
			slots.push(slot[1]);
			source += "(.+?)";
			return;
		}
		const words = part.trim().split(/\s+/);
		literal += squash(part).length;
		// Letters have to stand apart from what fills a slot, so "player" is not
		// "play" and "er"; a script written without spaces need not.
		const spaced = /\s$/.test(part) || LETTER.test(part.trimEnd());
		const before = /^\s/.test(part) || /^\p{Script=Latin}/u.test(part.trimStart());
		if (index > 0) source += before ? "\\s+" : "\\s*";
		source += words.map(escaped).join("\\s*");
		if (index < parts.length - 1) source += spaced ? "\\s+" : "\\s*";
	});
	return { command, regex: new RegExp(`^${source}$`, "iu"), slots, literal, language };
}

/** Every phrase of every language, the language heard first, most specific first. */
function phrases(heard: Language | undefined): Phrase[] {
	const found: Phrase[] = [];
	for (const language of LANGUAGES) {
		for (const [command, said] of Object.entries(languagePatterns(language)?.commands ?? {})) {
			for (const phrase of said) found.push(compile(command, phrase, language));
		}
	}
	const rank = (phrase: Phrase) => (phrase.language === heard ? 0 : 1);
	return found.sort((a, b) => rank(a) - rank(b) || a.slots.length - b.slots.length || b.literal - a.literal);
}

/** Whether `word` is in `text`: as a word if written in letters, else anywhere. */
function contains(text: string, word: string) {
	const wanted = word.normalize("NFKC").toLowerCase();
	const lower = text.toLowerCase();
	if (!/^[\p{Script=Latin}'’ ]+$/u.test(wanted)) return lower.includes(wanted);
	return new RegExp(`(^|[^\\p{L}])${escaped(wanted)}($|[^\\p{L}])`, "u").test(lower);
}

/** Whether what fills a slot asks for more than a plain value of it. */
function asksMore(value: string, patterns: VoicePatterns | undefined) {
	if (CLAUSES.test(value)) return true;
	const lower = value.toLowerCase();
	if (patterns?.defer?.some((word) => contains(value, word))) return true;
	return (
		patterns?.deferStarts?.some((word) => {
			const start = word.normalize("NFKC").toLowerCase();
			if (!lower.startsWith(start)) return false;
			// "this" starts "this is america" too, but only "thistle" is another word.
			return !/\p{Script=Latin}$/u.test(start) || !/^\p{L}/u.test(lower.slice(start.length));
		}) ?? false
	);
}

/** `text` without sentence punctuation at its end or polite words at either. */
function plain(text: string) {
	const polite = LANGUAGES.flatMap((language) => languagePatterns(language)?.polite ?? [])
		.map((word) => word.normalize("NFKC"))
		.sort((a, b) => b.length - a.length);
	const end = /[\s,，、.。!！]+$/u;
	let current = text.replace(end, "");
	for (let changed = true; changed; ) {
		changed = false;
		for (const word of polite) {
			const lower = current.toLowerCase();
			const wanted = word.toLowerCase();
			const letters = LETTER.test(word);
			if (lower.endsWith(wanted) && (!letters || /[\s,，、]$/u.test(current.slice(0, -word.length)))) {
				current = current.slice(0, -word.length).replace(end, "");
				changed = true;
			} else if (lower.startsWith(wanted) && (!letters || /^[\s,，、]/u.test(current.slice(word.length)))) {
				current = current.slice(word.length).replace(/^[\s,，、]+/u, "");
				changed = true;
			}
		}
	}
	return current;
}

function distance(a: string, b: string) {
	let row = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const next = [i];
		for (let j = 1; j <= b.length; j++) {
			next[j] = Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		row = next;
	}
	return row[b.length] ?? 0;
}

/** Whether `lead` is what the recogniser made of the bot's name. */
function isName(lead: string) {
	const squashed = squash(lead);
	return LANGUAGES.flatMap((language) => languagePatterns(language)?.name ?? []).some((name) => {
		const wanted = squash(name);
		if (squashed === wanted) return true;
		return /^[a-z]+$/.test(wanted) && squashed.length >= NAME_LENGTH && distance(squashed, wanted) <= NAME_DISTANCE;
	});
}

/** What was said, and it again without whatever came before the command. */
function readings(text: string, fits: (candidate: string) => boolean) {
	const found = [text];
	const clause = /^([^,，、.。!！?？]+)[,，、.。!！]+\s*(.+)$/su.exec(text);
	// A name kept by the recogniser usually comes with a comma. What came before
	// it being a command itself means two were asked for.
	if (clause?.[1] && clause[2] && clause[1].trim().split(/\s+/).length <= NAME_WORDS && !fits(clause[1])) {
		const refused = LANGUAGES.some((language) =>
			languagePatterns(language)?.defer?.some((word) => contains(clause[1] ?? "", word)),
		);
		if (!refused) found.push(clause[2]);
	}
	const words = text.split(/\s+/);
	for (let count = NAME_WORDS; count >= 1; count--) {
		if (words.length > count && isName(words.slice(0, count).join(" "))) found.push(words.slice(count).join(" "));
	}
	return found;
}

/**
 * Each way what was said fits a phrase, likeliest first. The caller holds them to
 * the commands' own options, so one that fills a number with words is passed over.
 */
export function quickMatches(text: string, lang: string | null): QuickMatch[] {
	const said = text.normalize("NFKC").trim();
	// A question is for the model, whatever words it is in.
	if (!said || /[?？]$/u.test(said)) return [];
	const heard = recogniserLanguage(lang);
	const all = phrases(heard);
	const matches: QuickMatch[] = [];
	const fitting = (candidate: string) => {
		const found: QuickMatch[] = [];
		for (const phrase of all) {
			const match = phrase.regex.exec(candidate);
			if (!match) continue;
			const values = match.slice(1);
			const patterns = languagePatterns(phrase.language);
			if (values.some((value) => asksMore(value, patterns))) continue;
			const raw: Record<string, unknown> = { command: phrase.command };
			phrase.slots.forEach((slot, index) => {
				raw[slot] = values[index]?.replace(TITLE_MARKS, "").trim();
			});
			// Words of English say nothing about the language to answer in.
			const language = phrase.language === Language.English ? (heard ?? Language.English) : phrase.language;
			found.push({ raw, language });
		}
		return found;
	};
	const cleaned = plain(said);
	for (const reading of readings(cleaned, (candidate) => fitting(plain(candidate)).length > 0)) {
		const candidate = plain(reading);
		if (reading !== cleaned && CLAUSES.test(candidate)) continue;
		matches.push(...fitting(candidate));
	}
	return matches;
}
