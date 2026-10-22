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
 * Unset, or when the server does not answer in time, the plain fallback in
 * `intent.ts` reads the command: a command's own name, said first.
 */

export const DEFAULT_INTENT_MODEL = "mlx-community/Qwen3-4B-4bit";

/** Longer than this and the fallback answers instead. */
const ANSWER_WITHIN_MS = 3000;

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

/** The options of a command the model may set. */
function optionsOf(name: string, lookup: Lookup): OptionSpec[] {
	const command = lookup(name);
	if (!command) return [];
	return ((command.data.toJSON().options ?? []) as OptionSpec[]).filter(
		(option) => TYPES[option.type] && !HIDDEN.has(`${name}.${option.name}`),
	);
}

/** The commands and their options, as the model is told them. */
export function catalogue(lookup: Lookup): string {
	return MUSIC_COMMANDS.filter((name) => lookup(name))
		.map((name) => {
			const lines = [`- ${name}: ${HINTS[name] ?? lookup(name)?.data.description}`];
			for (const option of optionsOf(name, lookup)) {
				const range =
					option.min_value !== undefined || option.max_value !== undefined
						? `, ${option.min_value ?? "…"} to ${option.max_value ?? "…"}`
						: "";
				const need = option.required ? "required" : "optional";
				lines.push(
					`    ${option.name} (${TYPES[option.type]}${range}, ${need}): ${
						HINTS[`${name}.${option.name}`] ?? option.description
					}`,
				);
			}
			return lines.join("\n");
		})
		.join("\n");
}

/**
 * The examples are not taken from the transcripts the model was measured on,
 * so the measurement says how it does on what it has not seen.
 */
export function intentPrompt(lookup: Lookup): string {
	return `You read voice commands for a Discord music bot named Amhra. The input is a speech-recognition transcript of what someone said right after saying the bot's name. It is often garbled: what is left of the name may appear at the start, misspelled ("I'm Har", "Ehara", "hammer", "Em,"), and words may be misheard ("pay" for "play", "pre" for "pause").

Decide which of these commands they meant, and its options:
${catalogue(lookup)}

Anything else — chatter, only the name, a question that is not one of these, a request the bot cannot do, or something unclear — is none.

The transcript may be in English, Japanese, Korean or Chinese. Answer with one line of JSON and nothing else: the command under "command", and each option they gave under its name. Leave out options they did not give. When in doubt, answer {"command": "none"}.

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
"Imra, leave the call" -> {"command": "disconnect"}
"Ehra." -> {"command": "none"}
"what's for dinner" -> {"command": "none"}
"I'll play football later" -> {"command": "none"}
"次へ" -> {"command": "skip"}
"一時停止" -> {"command": "pause"} /no_think`;
}

export type IntentReading = {
	intent: VoiceIntent | null;
	/** Who decided: the model, or the fallback. */
	by: "model" | "fallback";
};

/** What someone asked for, read by the model when there is one. */
export async function readIntent(
	text: string,
	lang: string | null,
	lookup: Lookup,
	setting: Setting = readSetting(),
): Promise<IntentReading> {
	const url = setting.VOICE_INTENT_MODEL_URL;
	if (url) {
		const model = setting.VOICE_INTENT_MODEL ?? DEFAULT_INTENT_MODEL;
		const answer = await askModel(url, model, intentPrompt(lookup), text);
		if (answer !== undefined) {
			const language = recogniserLanguage(lang) ?? Language.English;
			return { intent: intentFrom(answer, language, lookup), by: "model" };
		}
	}
	return { intent: parseVoiceCommand(text, lang), by: "fallback" };
}

/** The model's answer, or undefined when there was none to be had. */
async function askModel(
	url: string,
	model: string,
	prompt: string,
	text: string,
): Promise<string | undefined> {
	try {
		const response = await fetch(`${url.replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages: [
					{ role: "system", content: prompt },
					{ role: "user", content: text },
				],
				temperature: 0,
				max_tokens: 80,
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
 * The command in a model's answer, held to the music commands and to each
 * option's type and range. An option that does not fit is left out; a
 * command missing a required one, an unknown command, or anything that is
 * not JSON, is no command.
 */
export function intentFrom(answer: string, language: Language, lookup: Lookup): VoiceIntent | null {
	const json = /\{[\s\S]*?\}/.exec(answer.replace(/<think>[\s\S]*?<\/think>/g, ""))?.[0];
	if (!json) return null;
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(json);
	} catch {
		return null;
	}
	const name = typeof raw.command === "string" ? raw.command.trim().toLowerCase() : "";
	const command = MUSIC_COMMANDS.find((known) => known === name);
	if (!command || !lookup(command)) return null;

	const options: VoiceOptions = {};
	for (const spec of optionsOf(command, lookup)) {
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
	return { command: command as Exclude<MusicCommandName, "play">, language, ...given(options) };
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
