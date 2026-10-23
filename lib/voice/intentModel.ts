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
 * settings), and has one command of its own, `speak`: an answer said aloud,
 * to a question or as a question back. After one, the bot listens to the
 * same person again without the name, and their reply is read with what was
 * said before.
 *
 * One request may ask for several things ("skip this and turn it down to
 * 40"): the model answers with a list of actions, done in turn, each as a
 * command typed on its own would be.
 *
 * Unset, or when the server does not answer in time, the plain fallback in
 * `intent.ts` reads the command: a command's own name, said first.
 */

export const DEFAULT_INTENT_MODEL = "mlx-community/Qwen3-4B-4bit";

/**
 * Longer than this and the fallback answers instead. Room for a spoken answer
 * a sentence or two long; the waiting sound covers the wait.
 */
const ANSWER_WITHIN_MS = 6000;
/** Enough for a few commands, or a spoken answer of a sentence or two. */
const MAX_TOKENS = 300;
/** The most actions one request is taken to ask for; the rest are left. */
export const MAX_ACTIONS = 5;
/** The longest spoken answer, in characters: past this it is cut. */
export const MAX_SPOKEN = 300;

/** The model's own command: answer them aloud, then listen for their reply. */
export const SPEAK = "speak";

/** An answer the model gives aloud rather than a command it runs. */
export type SpokenReply = { command: typeof SPEAK; text: string; language: Language };

/** One thing to do for a request: a command, or an answer said aloud. */
export type Action = VoiceIntent | SpokenReply;

/** A turn of a conversation, as the model is sent it. */
export type Turn = { role: "user" | "assistant"; content: string };

/** What the model is told besides the transcript. */
export interface Conversation {
	/** The bot's state (see `voiceContext.ts`). */
	context?: string;
	/** What was said before, when the bot is answering a reply to itself. */
	history?: Turn[];
}

type Lookup = (name: string) => Command<SlashCommandBuilder> | undefined;

/**
 * What the model is told about a command or an option, where the slash
 * command's own description would mislead it or says too little.
 */
const HINTS: Record<string, string> = {
	resume: "Resume the paused music; also what a bare \"play\", with no song named, means",
	"play.search": "the song to play, as they said it",
	"play.next": "true to play it straight after the current song",
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
	mix: "Play songs or sounds on top of the queue's song, each at its own volume",
	"mix.add.search": "the song or sound to mix in, as they said it",
	"mix.add.volume": "a percentage, 100 being normal; only a number they said",
	"mix.remove.layer": "which mixed-in song, from 1, in the order they were mixed in",
	"mix.volume.layer": "which mixed-in song, from 1, in the order they were mixed in",
	"mix.volume.volume": "a percentage, 100 being normal; only a number they said",
	"mix.main.volume": "a percentage, 100 being normal; only a number they said",
	"mix.swap.layer": "which mixed-in song, from 1, in the order they were mixed in",
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
 */
export function intentPrompt(lookup: Lookup, context?: string): string {
	const state = context ? `\nThe bot right now:\n${context}\n` : "";
	return `You read voice commands for a Discord music bot named Amhra. The input is a speech-recognition transcript of what someone said right after saying the bot's name, or of their reply when the bot has just answered them aloud. It is often garbled: what is left of the name may appear at the start, misspelled ("I'm Har", "Ehara", "hammer", "Em,"), and words may be misheard ("pay" for "play", "pre" for "pause").

Decide which of these commands they meant, and its options:
${catalogue(lookup)}
- ${SPEAK}: Answer them aloud instead of running a command: a question about what is playing, the queue, the volume or the settings, answered from the state below; or, when what they want is unclear, a short question back. Give "text": what to say, one or two short sentences, in the language they spoke. They can answer back without saying the name.
${state}
Anything else — chatter, only the name, a request the bot cannot do, or something too unclear even to ask about — is none.

The transcript may be in English, Japanese, Korean or Chinese. Answer with one line of JSON and nothing else: the command under "command", its subcommand under "subcommand" for a command that has them, and each option they gave under its name. Leave out options they did not give. When they ask for several things at once, answer with a list of them in the order to do them, at most ${MAX_ACTIONS}, with any speak last. When in doubt, answer {"command": "none"}.

Examples:
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
"stop the second mixed in song" -> {"command": "mix", "subcommand": "remove", "layer": 2}
"what's in the mix" -> {"command": "mix", "subcommand": "list"}
"Imra, leave the call" -> {"command": "disconnect"}
"skip this and turn it down to 40" -> [{"command": "skip"}, {"command": "volume", "volume": 40}]
"play bad guy next and put it on repeat" -> [{"command": "play", "search": "bad guy", "next": true}, {"command": "loop", "enabled": true}]
"pause and tell me what's playing" -> [{"command": "pause"}, {"command": "${SPEAK}", "text": "That was Hello by Adele."}]
"how many songs are left" -> {"command": "${SPEAK}", "text": "Three more after this one."}
"play that one again" -> {"command": "${SPEAK}", "text": "Which song do you want to hear again?"}
"Ehra." -> {"command": "none"}
"what's for dinner" -> {"command": "none"}
"I'll play football later" -> {"command": "none"}
"次へ" -> {"command": "skip"}
"一時停止" -> {"command": "pause"} /no_think`;
}

export type IntentReading = {
	/** What to do, in order. None when they asked for nothing the bot does. */
	intents: Action[];
	/** Who decided: the model, or the fallback. */
	by: "model" | "fallback";
	/** The model's answer as it gave it, to carry a conversation on with. */
	answer?: string;
};

/** What someone asked for, read by the model when there is one. */
export async function readIntent(
	text: string,
	lang: string | null,
	lookup: Lookup,
	setting: Setting = readSetting(),
	{ context, history = [] }: Conversation = {},
): Promise<IntentReading> {
	const url = setting.VOICE_INTENT_MODEL_URL;
	if (url) {
		const model = setting.VOICE_INTENT_MODEL ?? DEFAULT_INTENT_MODEL;
		const messages = [
			{ role: "system", content: intentPrompt(lookup, context) },
			...history,
			{ role: "user", content: text },
		];
		const answer = await askModel(url, model, messages);
		if (answer !== undefined) {
			const language = recogniserLanguage(lang) ?? Language.English;
			return { intents: intentsFrom(answer, language, lookup), by: "model", answer };
		}
	}
	const intent = parseVoiceCommand(text, lang);
	return { intents: intent ? [intent] : [], by: "fallback" };
}

/** The model's answer, or undefined when there was none to be had. */
async function askModel(
	url: string,
	model: string,
	messages: { role: string; content: string }[],
): Promise<string | undefined> {
	try {
		const response = await fetch(`${url.replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages,
				temperature: 0,
				max_tokens: MAX_TOKENS,
			}),
			signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const body = (await response.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		const content = body.choices?.[0]?.message?.content;
		if (typeof content !== "string") throw new Error("no answer in the reply");
		return content;
	} catch (error) {
		globalApp.warn(`Voice command model at ${url} did not answer, falling back to command names: ${error}`);
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
	const json = jsonIn(answer);
	const items = Array.isArray(json) ? json : [json];
	return items
		.map((item) => actionFrom(item, language, lookup))
		.filter((action): action is Action => action !== null)
		.slice(0, MAX_ACTIONS);
}

/**
 * The command in a model's answer of one, held to the music commands and to
 * each option's type and range. An option that does not fit is left out; a
 * command missing a required one, an unknown command, or anything that is
 * not a JSON object, is no command. A spoken answer needs something to say.
 */
export function intentFrom(answer: string, language: Language, lookup: Lookup): Action | null {
	return actionFrom(jsonIn(answer), language, lookup);
}

function actionFrom(json: unknown, language: Language, lookup: Lookup): Action | null {
	if (!json || typeof json !== "object" || Array.isArray(json)) return null;
	const raw = json as Record<string, unknown>;
	const name = typeof raw.command === "string" ? raw.command.trim().toLowerCase() : "";
	if (name === SPEAK) {
		const text = typeof raw.text === "string" ? raw.text.trim() : "";
		return text ? { command: SPEAK, text: [...text].slice(0, MAX_SPOKEN).join(""), language } : null;
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
		const query = typeof options.search === "string" ? options.search : "";
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
