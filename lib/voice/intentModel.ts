import {
	type APIApplicationCommandOption,
	ApplicationCommandOptionType,
	type SlashCommandBuilder,
} from "discord.js";
import { type Command, Language } from "../interaction";
import { globalApp } from "../misc";
import { readSetting, type Setting } from "../setting";
import {
	MUSIC_COMMANDS,
	type MusicCommandName,
	parseVoiceCommand,
	recogniserLanguage,
	type VoiceIntent,
	type VoiceOptions,
} from "./intent";
import type { YouTubeVideo } from "../youtube";
import { defaultIntentModel, intentServer, modelEndpoint, THINKING_TOKENS } from "./intentServer";
import { quickMatches } from "./quickMatch";
import { VOICE_LANGUAGES, type VoiceLanguage } from "./voiceSetting";

/**
 * Reading a command with a language model running on the bot's own machine.
 *
 * When `VOICE_INTENT_MODEL_URL` points at an OpenAI-compatible server
 * (`mlx_lm.server`, LM Studio, Ollama), every transcript goes to it and its
 * answer decides what runs. It reads requests said any way at all
 * ("can you put on something by Olivia Rodrigo", "turn it down to 50") and
 * may use any command about the music, with its options. It can also take
 * chatter for a command. Its answer
 * is held to those commands and to each option's type and range, and the
 * command's own handler makes every other check, so the worst it can do is
 * what a typed command could.
 *
 * It is told the bot's state (what is playing, the queue, the volume, the
 * settings), and has two commands of its own, both said aloud: `speak`, an
 * answer that ends it, and `request_input`, a question back, after which the
 * bot listens to the same person again without the name and reads their
 * reply with what was said before. A reply that only closes the conversation
 * ("ok", "thank you") is no action at all.
 *
 * It may also `search` YouTube before it decides: the results are sent back
 * to it, and it answers again: playing one by its number, which the bot
 * turns into its link, saying something about them, or asking which.
 *
 * One request may ask for several things ("skip this and turn it down to
 * 40"): the model answers with a list of actions, done in turn, each as a
 * command typed on its own would be.
 *
 * Told it can, it may also `retranscribe`: have the recogniser hear them again
 * in a language it names, when what it was sent looks like a wrong guess at the
 * language. It reads what comes back in place of the first.
 *
 * Commands said plainly never come here (see `quickMatch.ts`).
 *
 * Unset, or when the server does not answer in time, the plain fallback in
 * `intent.ts` reads the command: a command's own name, said first. A server
 * on this machine is started by the bot itself (see `intentServer.ts`), and
 * until it is ready the fallback reads every command.
 */

export const DEFAULT_INTENT_MODEL = defaultIntentModel();

/**
 * Longer than this and the fallback answers instead. Room for a spoken answer
 * a sentence or two long; the waiting sound covers the wait.
 */
const ANSWER_WITHIN_MS = 6000;
/**
 * And this long for a model that thinks first: at the 40 tokens a second of
 * a small machine, the whole of its thinking and a short answer.
 */
const THINKING_WITHIN_MS = 30_000;
/** Enough for a few commands, or a spoken answer of a sentence or two. */
const MAX_TOKENS = 300;
/** The most actions one request is taken to ask for; the rest are left. */
export const MAX_ACTIONS = 5;
/** The longest spoken answer, in characters: past this it is cut. */
export const MAX_SPOKEN = 300;
/** Searches for one request; past this the model has to decide. */
export const MAX_SEARCHES = 2;
/** Search results the model is shown. */
export const SEARCH_RESULTS = 5;

/** The model's own command: answer them aloud, and that is all. */
export const SPEAK = "speak";
/** The model's other command: ask them aloud, then listen for their reply. */
export const REQUEST_INPUT = "request_input";

/** Something the model says aloud rather than a command it runs. */
export type SpokenReply = {
	command: typeof SPEAK | typeof REQUEST_INPUT;
	text: string;
	language: Language;
};

/** Whether `action` is said aloud, rather than run. */
export function isSpoken(action: Action): action is SpokenReply {
	return action.command === SPEAK || action.command === REQUEST_INPUT;
}

/** One thing to do for a request: a command, or an answer said aloud. */
export type Action = VoiceIntent | SpokenReply;

/** The model's third command: look a song up before deciding. */
export const SEARCH = "search";
type SearchRequest = { command: typeof SEARCH; query: string };

/** The model's fourth command: hear them again, in a language it must name. */
export const RETRANSCRIBE = "retranscribe";
type RetranscribeRequest = { command: typeof RETRANSCRIBE; language: VoiceLanguage };

/** What the recogniser made of them. */
export type Heard = { text: string; lang: string | null };

/** Hear their last command again in `language`; null if nothing came of it. */
export type Retranscribe = (language: VoiceLanguage) => Promise<Heard | null>;

/** Songs found for a search, best first. */
export type Search = (query: string) => Promise<YouTubeVideo[]>;

/** A turn of a conversation, as the model is sent it. */
export type Turn = { role: "user" | "assistant"; content: string };

/** What the model is told besides the transcript. */
export interface Conversation {
	/** The bot's state (see `voiceContext.ts`). */
	context?: string;
	/** What was said before, when the bot is answering a reply to itself. */
	history?: Turn[];
	/** How the model's searches are made; YouTube unless told otherwise. */
	search?: Search;
	/** How they are heard again; without it the model is not told it can. */
	retranscribe?: Retranscribe;
	/** What they chose to be answered in, whichever language they spoke. */
	answerIn?: VoiceLanguage;
	/** The languages they speak, the likeliest first. */
	speaks?: VoiceLanguage[];
}

type Lookup = (name: string) => Command<SlashCommandBuilder> | undefined;

/**
 * What the model is told about a command or an option, where the slash
 * command's own description would mislead it or says too little.
 */
/** The `queue` option most commands share; see lib/voice/queueOption.ts. */
const QUEUE_ONE = "which queue, by number, only when they name one; leave out for queue 1";
const QUEUE_ALL = "which queue, by number, only when they name one; leave out to mean every queue";
const QUEUE_TRACK = "which queue, by its number, 2 and up";

const HINTS: Record<string, string> = {
	resume: "Resume the paused music; also what a bare \"play\", with no song named, means",
	"play.search": "the song to play, as they said it",
	"play.next": "true to play it straight after the current song",
	"play.queue": "which queue to play it on, by number, only when they name one; a number with no queue yet starts one",
	"skip.queue": QUEUE_ONE,
	"remove.queue": QUEUE_ONE,
	"queue.queue": QUEUE_ONE,
	"loop.queue": QUEUE_ONE,
	"nowplaying.queue": QUEUE_ONE,
	"skipnonmusic.queue": QUEUE_ONE,
	"autoskipnonmusic.queue": QUEUE_ONE,
	"relocate.queue": QUEUE_ONE,
	"lyrics.queue": QUEUE_ONE,
	"pause.queue": QUEUE_ALL,
	"resume.queue": QUEUE_ALL,
	"stop.queue": QUEUE_ALL,
	"volume.queue": "which queue's own volume, by number, only when they name one; leave out for the whole bot's volume",
	"skip.force": "true only if they ask to force it, with no vote",
	"skip.amount": "how many songs to skip, when they say a number",
	skipnonmusic: "Skip the part of the video playing that is not music, such as an intro or talking",
	autoskipnonmusic: "Turn automatically skipping the non-music parts of videos on or off",
	"autoskipnonmusic.enabled": "true for on, false for off; leave out to toggle",
	loop: "Turn looping the current song on or off",
	"loop.enabled": "true for on, false for off; leave out to toggle",
	"queue.page": "which page of the queue, from 1",
	"remove.index": "the song's place in the queue, from 1",
	"volume.volume": "a percentage, 100 being normal; only a number they said",
	"lyrics.search": "a song to look up instead of the one playing",
	"relocate.position": "where in the song to play from, as seconds or M:SS",
	mix: "Manage the queues mixed in over queue 1 (queues 2 and up), each playing at once with its own songs and volume",
	"mix.add.search": "the song or sound to mix in, as they said it",
	"mix.add.queue": "which queue to put it on, by its number, 2 and up; leave out for a new one",
	"mix.add.volume": "a percentage, 100 being normal; only a number they said",
	"mix.add.gap": "seconds between the queue's songs; only a number they said",
	"mix.remove.queue": QUEUE_TRACK,
	"mix.remove.song": "which song in that queue, from 1; leave out to remove the whole queue",
	"mix.skip.queue": QUEUE_TRACK,
	"mix.volume.queue": QUEUE_TRACK,
	"mix.volume.volume": "a percentage, 100 being normal; only a number they said",
	"mix.gap.queue": QUEUE_TRACK,
	"mix.gap.seconds": "seconds of silence between songs; only a number they said",
	"mix.loop.queue": QUEUE_TRACK,
	"mix.loop.enabled": "true for on, false for off; leave out to toggle",
	"mix.main.volume": "a percentage, 100 being normal; only a number they said",
};

/** Options the model is not to set: they are for fixing things by hand. */
const HIDDEN = new Set(["play.force", "play.volume"]);

const TYPES: Partial<Record<ApplicationCommandOptionType, string>> = {
	[ApplicationCommandOptionType.String]: "text",
	[ApplicationCommandOptionType.Integer]: "whole number",
	[ApplicationCommandOptionType.Number]: "number",
	[ApplicationCommandOptionType.Boolean]: "true or false",
};

type OptionSpec = APIApplicationCommandOption & {
	required?: boolean;
	min_value?: number;
	max_value?: number;
};

type SubcommandSpec = APIApplicationCommandOption & { options?: OptionSpec[] };

/** A command's subcommands, such as mix's add and remove; none for most. */
function subcommandsOf(name: string, lookup: Lookup): SubcommandSpec[] {
	const command = lookup(name);
	if (!command) return [];
	return ((command.data.toJSON().options ?? []) as SubcommandSpec[]).filter(
		(option) => option.type === ApplicationCommandOptionType.Subcommand,
	);
}

/**
 * The options of a command, or of one of its subcommands, the model may set.
 * `path` is how hints and hidden options name them: `play`, or `mix.add`.
 */
function optionsOf(name: string, lookup: Lookup, subcommand?: string): OptionSpec[] {
	const command = lookup(name);
	if (!command) return [];
	const path = subcommand ? `${name}.${subcommand}` : name;
	const options = subcommand
		? (subcommandsOf(name, lookup).find((sub) => sub.name === subcommand)?.options ?? [])
		: ((command.data.toJSON().options ?? []) as OptionSpec[]);
	return options.filter((option) => TYPES[option.type] && !HIDDEN.has(`${path}.${option.name}`));
}

/** One option as the model is told it, under `path` for its hint. */
function optionLine(option: OptionSpec, path: string, indent: string) {
	const range =
		option.min_value !== undefined || option.max_value !== undefined
			? `, ${option.min_value ?? "…"} to ${option.max_value ?? "…"}`
			: "";
	const need = option.required ? "required" : "optional";
	return `${indent}${option.name} (${TYPES[option.type]}${range}, ${need}): ${
		HINTS[`${path}.${option.name}`] ?? option.description
	}`;
}

/** The commands and their options, as the model is told them. */
export function catalogue(lookup: Lookup): string {
	return MUSIC_COMMANDS.filter((name) => lookup(name))
		.map((name) => {
			const description = HINTS[name] ?? lookup(name)?.data.description;
			const subcommands = subcommandsOf(name, lookup);
			if (subcommands.length) {
				const lines = [`- ${name}: ${description}. Give "subcommand" as one of:`];
				for (const sub of subcommands) {
					lines.push(`    ${sub.name}: ${HINTS[`${name}.${sub.name}`] ?? sub.description}`);
					for (const option of optionsOf(name, lookup, sub.name)) {
						lines.push(optionLine(option, `${name}.${sub.name}`, "        "));
					}
				}
				return lines.join("\n");
			}
			const lines = [`- ${name}: ${description}`];
			for (const option of optionsOf(name, lookup)) {
				lines.push(optionLine(option, name, "    "));
			}
			return lines.join("\n");
		})
		.join("\n");
}

/**
 * The examples are not taken from the transcripts the model was measured on,
 * so the measurement says how it does on what it has not seen.
 *
 * The search examples come before the rest. Last, Qwen3 4B followed their one
 * object a line and answered "skip this and turn it down to 40" with one
 * object holding both commands, of which only the last was kept.
 */
export function intentPrompt(
	lookup: Lookup,
	context?: string,
	canRetranscribe = false,
	answerIn?: VoiceLanguage,
	speaks: VoiceLanguage[] = [],
): string {
	const told = context ? `\nThe bot right now:\n${context}\n` : "";
	const ranked = speaks.map((language) => `${language} (${VOICE_LANGUAGES[language]})`).join(" > ");
	const spoken = speaks.length ? `\nThe languages they speak, the likeliest first: ${ranked}.\n` : "";
	const answers = answerIn
		? `\nThey chose to be answered in ${VOICE_LANGUAGES[answerIn]}: write every "text" in it, whatever language they spoke.\n`
		: "";
	const state = `${told}${spoken}${answers}`;
	const choosing = speaks.length
		? ` Choose by the languages they speak, given below: the first of them the transcript could be a mishearing of. A transcript in a language they do not speak is very likely a wrong guess; one in a language they do speak that makes sense is not.`
		: "";
	const again = canRetranscribe
		? `\n- ${RETRANSCRIBE}: Have the speech recogniser hear them again, when the transcript makes no sense because it guessed the wrong language: gibberish, or a script that fits nothing they would ask. Give "language", which is required: ${Object.entries(VOICE_LANGUAGES)
				.map(([code, name]) => `${code} for ${name}`)
				.join(", ")}. Answer with it alone, and at most once. What it hears comes back as the next message, 'Heard again in …: "…"': read that instead of the transcript. Do not use it for words that are merely misheard, which you can work out.${choosing}`
		: "";
	const againExamples = canRetranscribe
		? `\n"스킵 더 송" -> {"command": "${RETRANSCRIBE}", "language": "en"}\n  Heard again in en: "skip the song" -> {"command": "skip"}\n"pose zan ting" -> {"command": "${RETRANSCRIBE}", "language": "zh"}`
		: "";
	return `You read voice commands for a Discord music bot named Amhra. The input is a speech-recognition transcript of what someone said right after saying the bot's name, or of their reply when the bot has just answered them aloud. It is often garbled: what is left of the name may appear at the start, misspelled ("I'm Har", "Ehara", "hammer", "Em,"), and words may be misheard ("pay" for "play", "pre" for "pause").

Decide which of these commands they meant, and its options:
${catalogue(lookup)}
- ${SPEAK}: Answer them aloud instead of running a command: a question about what is playing, the queue, the volume or the settings, answered from the state below. Give "text": what to say, one or two short sentences, in the language they spoke. The bot does not listen after it.
- ${REQUEST_INPUT}: Ask them something aloud and listen for their answer, which they give without saying the name: when what they want is unclear, or a command needs something they did not say. Give "text": the question, one short sentence, in the language they spoke.
- ${SEARCH}: Look songs up on YouTube before deciding, when a plain play would not do: they want a particular version (live, acoustic, a cover, by someone), describe a song without naming it, or ask about a song that is not playing (who sings it, how long it is). Never answer about such a song from memory: search. Give "search": what to look up. Answer with it alone, not in a list. A plain "play" with a song's name needs no search.${again}
The results come back as the next message, numbered, each with its title, channel, length and link. Then answer what they asked: a question with ${SPEAK}, from the results; a song to play with play and "result": the number of the one they meant, in place of "search". Play the best fit, usually the first that matches: the official one for a song they named, the first live or acoustic one when they asked for that. Only when they asked to choose, or the results are different songs and nothing says which, ask with ${REQUEST_INPUT}, naming two or three briefly. When they answer such a question, or say "the other one", play from the results already shown by "result", never by "search".
${state}
Messages before the last one are what they said to the bot in the last minute, and how it answered: they are done. Use them only to understand the last one ("a bit louder", "play it again", "no, the other one", "a bit more" after turning it down, which means down again, the answer to a question you asked), and answer only what the last one asks: never do again what an earlier one asked.

Anything else — chatter, only the name, a request the bot cannot do, or something too unclear even to ask about — is no action. So is a reply that only ends the conversation, such as "ok", "thank you", "thanks", "never mind", "that's all" or "no": the bot says nothing back and stops listening.

The transcript may be in English, Japanese, Korean or Chinese. Answer with one line of JSON and nothing else: the command under "command", its subcommand under "subcommand" for a command that has them, and each option they gave under its name. Leave out options they did not give. When they ask for several things at once, answer with a list of them in the order to do them, at most ${MAX_ACTIONS}, with any ${SPEAK} or ${REQUEST_INPUT} last. For no action, answer with an empty list: []. When in doubt, answer [].

Examples of searching, with what comes back:
"play the live version of hotel california" -> {"command": "${SEARCH}", "search": "hotel california live"}
  Search results for "hotel california live":
  1. Eagles - Hotel California (Live 1977) - Eagles (7:12) https://www.youtube.com/watch?v=AAAAAAAAAA1
  2. Hotel California - Eagles (6:31) https://www.youtube.com/watch?v=AAAAAAAAAA2
  -> {"command": "play", "result": 1}
"who sings bad guy" -> {"command": "${SEARCH}", "search": "bad guy"}
  Search results for "bad guy":
  1. Billie Eilish - bad guy - Billie Eilish (3:26) https://www.youtube.com/watch?v=BBBBBBBBBB1
  -> {"command": "${SPEAK}", "text": "Bad Guy is by Billie Eilish."}
"how long is someone like you" -> {"command": "${SEARCH}", "search": "someone like you"}
  Search results for "someone like you":
  1. Adele - Someone Like You (Official Music Video) - Adele (4:45) https://www.youtube.com/watch?v=CCCCCCCCCC1
  -> {"command": "${SPEAK}", "text": "Someone Like You is about four and three quarter minutes long."}
"play a cover of yellow, let me pick" -> {"command": "${SEARCH}", "search": "yellow cover"}
  Search results for "yellow cover":
  1. Yellow - Coldplay (Acoustic Cover) - Jane Doe (4:10) https://www.youtube.com/watch?v=DDDDDDDDDD1
  2. Yellow (Rock Cover) - The Covers Band (4:30) https://www.youtube.com/watch?v=DDDDDDDDDD2
  -> {"command": "${REQUEST_INPUT}", "text": "I found an acoustic cover by Jane Doe and a rock one by The Covers Band. Which one?"}
  "the rock one" -> {"command": "play", "result": 2}
  "the second one" -> {"command": "play", "result": 2}

Other examples:
"Amra, next one please." -> {"command": "skip"}
"skip two songs" -> {"command": "skip", "amount": 2}
"I'm, play shape of you" -> {"command": "play", "search": "shape of you"}
"play shape of you after this one" -> {"command": "play", "search": "shape of you", "next": true}
"Emra, play." -> {"command": "resume"}
"Hmm, pause the music." -> {"command": "pause"}
"turn it down to 40" -> {"command": "volume", "volume": 40}
"put this song on repeat" -> {"command": "loop", "enabled": true}
"what song is this" -> {"command": "nowplaying"}
"take the third song off the queue" -> {"command": "remove", "index": 3}
"go to one minute twenty" -> {"command": "relocate", "position": "1:20"}
"mix in some rain sounds at 30 percent" -> {"command": "mix", "subcommand": "add", "search": "rain sounds", "volume": 30}
"stop the second mix track" -> {"command": "mix", "subcommand": "remove", "track": 2}
"what's in the mix" -> {"command": "mix", "subcommand": "list"}
"Imra, leave the call" -> {"command": "disconnect"}
"skip this and turn it down to 40" -> [{"command": "skip"}, {"command": "volume", "volume": 40}]
"play bad guy next and put it on repeat" -> [{"command": "play", "search": "bad guy", "next": true}, {"command": "loop", "enabled": true}]
"pause and tell me what's playing" -> [{"command": "pause"}, {"command": "${SPEAK}", "text": "That was Hello by Adele."}]
"how many songs are left" -> {"command": "${SPEAK}", "text": "Three more after this one."}
"play that one again" -> {"command": "${REQUEST_INPUT}", "text": "Which song do you want to hear again?"}
"put something on" -> {"command": "${REQUEST_INPUT}", "text": "What would you like to hear?"}
"Ok." -> []${againExamples}
"thank you" -> []
"cool, thanks" -> []
"never mind" -> []
"ありがとう" -> []
"Ehra." -> []
"what's for dinner" -> []
"I'll play football later" -> []
"次へ" -> {"command": "skip"}
"一時停止" -> {"command": "pause"} /no_think`;
}

export type IntentReading = {
	/** What to do, in order. None when they asked for nothing the bot does. */
	intents: Action[];
	/** Who decided: a plain phrase, the model, or the fallback. */
	by: "pattern" | "model" | "fallback";
	/** What they said, when it was heard again and that is what was read. */
	heard?: Heard;
	/** The model's answer as it gave it. */
	answer?: string;
	/**
	 * Everything after their words, to carry a conversation on with: each
	 * search the model asked for and its results, then its answer.
	 */
	turns?: Turn[];
};

/** Find songs on YouTube, loaded only when the model first searches. */
const searchYouTube: Search = (query) => import("../youtube.js").then((youtube) => youtube.searchYouTube(query));

/** `seconds` as M:SS, or H:MM:SS. */
function duration(seconds: number) {
	const whole = Math.max(0, Math.floor(seconds));
	const parts = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60];
	if (!parts[0]) parts.shift();
	return parts.map((part, index) => (index ? String(part).padStart(2, "0") : String(part))).join(":");
}

/** Search results as the model is shown them. */
export function searchResults(query: string, videos: YouTubeVideo[]) {
	const found = videos.slice(0, SEARCH_RESULTS);
	if (!found.length) return `Search results for "${query}": nothing found.`;
	return [
		`Search results for "${query}":`,
		...found.map(
			(video, index) =>
				`${index + 1}. ${video.title} - ${video.channel.name} (${duration(video.durationInSec)}) ${video.url}`,
		),
	].join("\n");
}

/** The search results the model has been shown, as their links. */
type Listed = {
	/** The latest search's, in order, for a result named by its number. */
	latest: string[];
	/** Every one shown in the conversation, for a link it gives back. */
	all: Set<string>;
};

const RESULT_LINE = /^\d+\. .* \(\d+(?::\d{2})+\) (\S+)$/;

/**
 * The results in the conversation so far, read back from the messages they
 * were shown in: a reply after a question back picks from the results sent
 * before it, which are only in the history by then.
 */
export function listedIn(turns: Turn[]): Listed {
	const listed: Listed = { latest: [], all: new Set() };
	for (const turn of turns) {
		if (turn.role !== "user" || !turn.content.startsWith("Search results for ")) continue;
		listed.latest = turn.content
			.split("\n")
			.map((line) => RESULT_LINE.exec(line)?.[1])
			.filter((link): link is string => link !== undefined);
		for (const link of listed.latest) listed.all.add(link);
	}
	return listed;
}

/**
 * What a play the model gave plays: a search result by its number, a link
 * to one, or else what it said. Null for a link it was never shown, which it
 * made up rather than found, and for a number past the results.
 */
function played(raw: Record<string, unknown>, search: string, listed: Listed): string | null {
	if (!search) return typeof raw.result === "number" ? (listed.latest[raw.result - 1] ?? null) : "";
	if (!listed.all.size) return search;
	// A result by its link, or by its video id alone.
	const link = [...listed.all].find((shown) => shown === search || shown.endsWith(`=${search}`));
	if (link) return link;
	return /youtu\.?be/.test(search) ? null : search;
}

/**
 * A command said so plainly that no model has to read it, held to the commands
 * and their options as the model's answer is; null for anything else.
 */
export function quickIntent(
	text: string,
	lang: string | null,
	lookup: Lookup,
	answerIn?: VoiceLanguage,
): IntentReading | null {
	const chosen = recogniserLanguage(answerIn ?? null);
	for (const { raw, language } of quickMatches(text, lang)) {
		const action = actionFrom(raw, chosen ?? language, lookup, listedIn([]));
		if (!action || action.command === SEARCH || action.command === RETRANSCRIBE) continue;
		// As the model's own answer, so what follows on from it can lean on it.
		const answer = JSON.stringify(raw);
		return { intents: [action], by: "pattern", answer, turns: [{ role: "assistant", content: answer }] };
	}
	return null;
}

/** What someone asked for, read by the model when there is one. */
export async function readIntent(
	text: string,
	lang: string | null,
	lookup: Lookup,
	setting: Setting = readSetting(),
	{ context, history = [], search = searchYouTube, retranscribe, answerIn, speaks }: Conversation = {},
): Promise<IntentReading> {
	let again: Heard | undefined;
	const chosen = recogniserLanguage(answerIn ?? null);
	const url = setting.VOICE_INTENT_MODEL_URL;
	const server = intentServer();
	// Still starting: nothing is gained by asking it, or by saying so each time.
	if (url && server?.ready !== false) {
		const model = modelEndpoint(setting)?.model ?? defaultIntentModel();
		let language = chosen ?? recogniserLanguage(lang) ?? Language.English;
		const turns: Turn[] = [];
		let searches = 0;
		let askedAgain = false;
		let thought = false;
		for (;;) {
			const messages = [
				{ role: "system", content: intentPrompt(lookup, context, retranscribe !== undefined, answerIn, speaks) },
				...history,
				{ role: "user", content: text },
				...turns,
			];
			const endpoint = modelEndpoint(setting);
			// A Gemma answers at once first. Thinking over every command took it
			// seconds and made it wrong more often than not thinking did.
			let answer = await askModel(url, model, messages, endpoint?.audio ? false : undefined);
			if (answer === undefined) break;
			const read = (answer: string) =>
				parsedActions(answer, language, lookup, listedIn([...history, ...turns, { role: "assistant", content: answer }]));
			let actions = read(answer);
			// Nothing made of it at once is what thinking is for, once.
			if (!actions.length && endpoint?.thinking && !thought) {
				thought = true;
				const considered = await askModel(url, model, messages, true);
				const found = considered === undefined ? [] : read(considered);
				if (considered !== undefined && found.length) {
					answer = considered;
					actions = found;
				}
			}
			turns.push({ role: "assistant", content: answer });
			const hearAgain = actions.find((action): action is RetranscribeRequest => action.command === RETRANSCRIBE);
			if (hearAgain && retranscribe && !askedAgain) {
				askedAgain = true;
				const heard = await retranscribe(hearAgain.language);
				if (heard) {
					again = heard;
					language = chosen ?? recogniserLanguage(heard.lang) ?? language;
				}
				turns.push({
					role: "user",
					content: `Heard again in ${hearAgain.language}: ${heard ? JSON.stringify(heard.text) : "nothing."}`,
				});
				continue;
			}
			const asked = actions.find((action): action is SearchRequest => action.command === SEARCH);
			// Searched enough: what it does with what it has found is its answer.
			if (!asked || searches >= MAX_SEARCHES) {
				const intents = actions.filter(isAction);
				return { intents: intents.slice(0, MAX_ACTIONS), by: "model", answer, turns, ...(again ? { heard: again } : {}) };
			}
			searches++;
			turns.push({ role: "user", content: searchResults(asked.query, await search(asked.query)) });
		}
		server?.notAnswering();
	}
	const intent = parseVoiceCommand(again?.text ?? text, again ? again.lang : lang);
	return {
		intents: intent ? [chosen ? { ...intent, language: chosen } : intent] : [],
		by: "fallback",
		...(again ? { heard: again } : {}),
	};
}

/** The model's answer, or undefined when there was none to be had. */
async function askModel(
	url: string,
	model: string,
	messages: { role: string; content: string }[],
	/** For a Gemma: whether it may think first. Undefined for any other model. */
	thinking?: boolean,
): Promise<string | undefined> {
	try {
		const response = await fetch(`${url.replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages,
				temperature: 0,
				// The thinking comes out of the same tokens as the answer.
				max_tokens: MAX_TOKENS + (thinking ? THINKING_TOKENS : 0),
				// Gemma takes no "/no_think": llama-server passes this on to
				// its template instead, for a server the bot did not start.
				...(thinking === undefined ? {} : { chat_template_kwargs: { enable_thinking: thinking } }),
			}),
			signal: AbortSignal.timeout(thinking ? THINKING_WITHIN_MS : ANSWER_WITHIN_MS),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const body = (await response.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		const content = body.choices?.[0]?.message?.content;
		if (typeof content !== "string") throw new Error("no answer in the reply");
		return content;
	} catch (error) {
		// "fetch failed" alone does not say whether anything was listening.
		const cause = error instanceof Error && error.cause ? ` (${error.cause})` : "";
		globalApp.warn(`Voice command model at ${url} did not answer, falling back to command names: ${error}${cause}`);
		return undefined;
	}
}

/**
 * The first JSON object or list in `answer`, past any thinking, or undefined
 * if there is none that parses. Strings are followed, so a bracket said in a
 * spoken answer does not end it.
 */
function jsonIn(answer: string): unknown {
	const text = answer.replace(/<think>[\s\S]*?<\/think>/g, "");
	const start = text.search(/[[{]/);
	if (start < 0) return undefined;
	let depth = 0;
	let quoted = false;
	for (let index = start; index < text.length; index++) {
		const character = text[index];
		if (quoted) {
			if (character === "\\") index++;
			else if (character === '"') quoted = false;
		} else if (character === '"') {
			quoted = true;
		} else if (character === "{" || character === "[") {
			depth++;
		} else if ((character === "}" || character === "]") && --depth === 0) {
			try {
				return JSON.parse(text.slice(start, index + 1));
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

/**
 * The actions in a model's answer, in order: one object, or a list of them.
 * Each is held as {@link intentFrom} holds one, and one that is not a command
 * is left out of the list, so the rest are still done; past
 * {@link MAX_ACTIONS}, the rest are left.
 */
export function intentsFrom(answer: string, language: Language, lookup: Lookup): Action[] {
	return parsedActions(answer, language, lookup)
		.filter(isAction)
		.slice(0, MAX_ACTIONS);
}

/** Every action in an answer, searches included, in its order. */
function parsedActions(answer: string, language: Language, lookup: Lookup, listed = listedIn([])) {
	const json = jsonIn(answer);
	const items = Array.isArray(json) ? json : [json];
	return items
		.map((item) => actionFrom(item, language, lookup, listed))
		.filter((action): action is Action | SearchRequest | RetranscribeRequest => action !== null);
}

/** Something to do, rather than something the model wanted to know first. */
function isAction(action: Action | SearchRequest | RetranscribeRequest): action is Action {
	return action.command !== SEARCH && action.command !== RETRANSCRIBE;
}

/**
 * The command in a model's answer of one, held to the music commands and to
 * each option's type and range. An option that does not fit is left out; a
 * command missing a required one, an unknown command, or anything that is
 * not a JSON object, is no command. A spoken answer needs something to say.
 */
export function intentFrom(answer: string, language: Language, lookup: Lookup): Action | null {
	const action = actionFrom(jsonIn(answer), language, lookup, listedIn([]));
	return action && isAction(action) ? action : null;
}

function actionFrom(
	json: unknown,
	language: Language,
	lookup: Lookup,
	listed: Listed,
): Action | SearchRequest | RetranscribeRequest | null {
	if (!json || typeof json !== "object" || Array.isArray(json)) return null;
	const raw = json as Record<string, unknown>;
	const name = typeof raw.command === "string" ? raw.command.trim().toLowerCase() : "";
	if (name === SEARCH) {
		const query = typeof raw.search === "string" ? raw.search.trim() : "";
		return query ? { command: SEARCH, query } : null;
	}
	if (name === RETRANSCRIBE) {
		// No language, no point: hearing it the same way hears the same thing.
		const asked = typeof raw.language === "string" ? raw.language.trim().toLowerCase() : "";
		return asked in VOICE_LANGUAGES ? { command: RETRANSCRIBE, language: asked as VoiceLanguage } : null;
	}
	if (name === SPEAK || name === REQUEST_INPUT) {
		const text = typeof raw.text === "string" ? raw.text.trim() : "";
		return text ? { command: name, text: [...text].slice(0, MAX_SPOKEN).join(""), language } : null;
	}
	const command = MUSIC_COMMANDS.find((known) => known === name);
	if (!command || !lookup(command)) return null;

	// A command with subcommands is nothing without one of them.
	const subcommands = subcommandsOf(command, lookup);
	let subcommand: string | undefined;
	if (subcommands.length) {
		const asked = typeof raw.subcommand === "string" ? raw.subcommand.trim().toLowerCase() : "";
		subcommand = subcommands.find((sub) => sub.name === asked)?.name;
		if (!subcommand) return null;
	}

	const options: VoiceOptions = {};
	for (const spec of optionsOf(command, lookup, subcommand)) {
		const value = fit(spec, raw[spec.name]);
		if (value !== undefined) options[spec.name] = value;
		else if (spec.required && !(command === "play" && spec.name === "search")) return null;
	}
	if (command === "play") {
		const query = played(raw, typeof options.search === "string" ? options.search : "", listed);
		if (query === null) return null;
		delete options.search;
		return query
			? { command, query, language, ...given(options) }
			: { command: "resume", language };
	}
	return {
		command: command as Exclude<MusicCommandName, "play">,
		language,
		...(subcommand ? { subcommand } : {}),
		...given(options),
	};
}

function given(options: VoiceOptions) {
	return Object.keys(options).length ? { options } : {};
}

/** `value` as the option takes it, or undefined if it does not fit. */
function fit(spec: OptionSpec, value: unknown): string | number | boolean | undefined {
	switch (spec.type) {
		case ApplicationCommandOptionType.String: {
			if (typeof value !== "string" && typeof value !== "number") return undefined;
			const text = String(value).trim();
			return text || undefined;
		}
		case ApplicationCommandOptionType.Boolean:
			return typeof value === "boolean" ? value : undefined;
		case ApplicationCommandOptionType.Integer:
		case ApplicationCommandOptionType.Number: {
			const number = typeof value === "string" ? Number(value) : value;
			if (typeof number !== "number" || !Number.isFinite(number)) return undefined;
			if (spec.type === ApplicationCommandOptionType.Integer && !Number.isInteger(number)) {
				return undefined;
			}
			if (spec.min_value !== undefined && number < spec.min_value) return undefined;
			if (spec.max_value !== undefined && number > spec.max_value) return undefined;
			return number;
		}
		default:
			return undefined;
	}
}
