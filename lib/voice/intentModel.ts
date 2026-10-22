import { Language } from "../interaction";
import { globalApp } from "../misc";
import { readSetting, type Setting } from "../setting";
import { parseVoiceCommand, recogniserLanguage, VOICE_COMMANDS, type VoiceIntent } from "./intent";

/**
 * Reading a command with a language model running on the bot's own machine.
 *
 * When `VOICE_INTENT_MODEL_URL` points at an OpenAI-compatible server
 * (`mlx_lm.server`, LM Studio, Ollama), every transcript goes to it and its
 * answer decides what runs. It reads requests the word lists do not know
 * ("can you put on something by Olivia Rodrigo") and forgives more of the
 * recogniser's mishearings. It is also wrong in ways the word lists are not:
 * it can take chatter for a command. The answer is held to the bot's own
 * commands, so the worst it can do is what a typed command could.
 *
 * Unset, or when the server does not answer in time, the word matching in
 * `intent.ts` reads the command as before.
 */

export const DEFAULT_INTENT_MODEL = "mlx-community/Qwen3-4B-4bit";

/** Longer than this and the word matching answers instead. */
const ANSWER_WITHIN_MS = 3000;

/**
 * The examples are not taken from the transcripts the model was measured on,
 * so the measurement says how it does on what it has not seen.
 */
export const INTENT_PROMPT = `You read voice commands for a Discord music bot named Amhra. The input is a speech-recognition transcript of what someone said right after saying the bot's name. It is often garbled: what is left of the name may appear at the start, misspelled ("I'm Har", "Ehara", "hammer", "Em,"), and words may be misheard ("pay" for "play", "pre" for "pause").

Decide which command they meant:
- play: <song> - play a particular song; give the song as they said it
- resume - carry on playing, or "play" with no song named
- pause
- skip - skip to the next song
- skipnonmusic - skip the part of the video that is not music (intro, talking)
- stop - stop the music
- disconnect - leave the voice channel
- none - anything else: chatter, only the name, a question, a request not on this list, or unclear

The transcript may be in English, Japanese, Korean or Chinese. Answer with only the command. When in doubt, answer none.

Examples:
"Amra, next one please." -> skip
"Hmm, pause the music." -> pause
"I'm, play shape of you" -> play: shape of you
"Emra, play." -> resume
"Ham, keep going" -> resume
"Ara stop the music." -> stop
"Imra, leave the call" -> disconnect
"Mmhara, skip the talking part" -> skipnonmusic
"Ehra." -> none
"what's for dinner" -> none
"I'll play football later" -> none
"次へ" -> skip
"一時停止" -> pause /no_think`;

export type IntentReading = {
	intent: VoiceIntent | null;
	/** Who decided: the model, or the word matching. */
	by: "model" | "words";
};

/** What someone asked for, read by the model when there is one. */
export async function readIntent(
	text: string,
	lang: string | null,
	setting: Setting = readSetting(),
): Promise<IntentReading> {
	const url = setting.VOICE_INTENT_MODEL_URL;
	if (url) {
		const answer = await askModel(url, setting.VOICE_INTENT_MODEL ?? DEFAULT_INTENT_MODEL, text);
		if (answer !== undefined) {
			const language = recogniserLanguage(lang) ?? Language.English;
			return { intent: intentFrom(answer, language), by: "model" };
		}
	}
	return { intent: parseVoiceCommand(text, lang), by: "words" };
}

/** The model's answer, or undefined when there was none to be had. */
async function askModel(url: string, model: string, text: string): Promise<string | undefined> {
	try {
		const response = await fetch(`${url.replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages: [
					{ role: "system", content: INTENT_PROMPT },
					{ role: "user", content: text },
				],
				temperature: 0,
				max_tokens: 40,
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
		globalApp.warn(`Voice command model at ${url} did not answer, matching words instead: ${error}`);
		return undefined;
	}
}

/**
 * The command in a model's answer, held to the bot's own. Anything else,
 * "none" included, is no command.
 */
export function intentFrom(answer: string, language: Language): VoiceIntent | null {
	const line =
		answer
			.replace(/<think>[\s\S]*?<\/think>/g, "")
			.trim()
			.split("\n")[0]
			?.trim()
			.replace(/^["'`]+|["'`.]+$/g, "")
			.trim() ?? "";
	const colon = line.indexOf(":");
	if (colon !== -1 && line.slice(0, colon).trim().toLowerCase() === "play") {
		const query = line
			.slice(colon + 1)
			.trim()
			.replace(/^["'`]+|["'`]+$/g, "")
			.trim();
		return query ? { command: "play", query, language } : { command: "resume", language };
	}
	const word = line.toLowerCase().replace(/[^a-z]/g, "");
	if (word === "play") return { command: "resume", language };
	const command = VOICE_COMMANDS.find((name) => name === word);
	return command && command !== "play" ? { command, language } : null;
}
