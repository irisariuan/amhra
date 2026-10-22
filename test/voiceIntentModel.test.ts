import { afterEach, describe, expect, test } from "bun:test";
import { Language } from "../lib/interaction";
import { DEFAULT_INTENT_MODEL, intentFrom, readIntent } from "../lib/voice/intentModel";

/**
 * A local model deciding what a voice command asks for, held to the bot's
 * own commands, with the word matching behind it when the model is not there.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const MODEL = { VOICE_INTENT_MODEL_URL: "http://127.0.0.1:8085/v1/" };

/** A server that answers `content`, keeping what it was asked. */
function answering(content: string) {
	const asked: { url: string; body: Record<string, unknown> }[] = [];
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		asked.push({ url, body: JSON.parse(String(init.body)) });
		return Response.json({ choices: [{ message: { content } }] });
	}) as unknown as typeof fetch;
	return asked;
}

function command(answer: string) {
	const intent = intentFrom(answer, Language.English);
	if (!intent) return null;
	return intent.command === "play" ? `play: ${intent.query}` : intent.command;
}

describe("what the model's answer is taken to mean", () => {
	test.each([
		["skip", "skip"],
		["Skip.", "skip"],
		["skipnonmusic", "skipnonmusic"],
		["play: expectations by Olivia Rodrigo", "play: expectations by Olivia Rodrigo"],
		['"play: Bohemian Rhapsody"', "play: Bohemian Rhapsody"],
		["play", "resume"],
		["play:", "resume"],
		["<think>\n\n</think>\n\npause", "pause"],
		["stop\nBecause they said stop.", "stop"],
	])("%p", (answer, expected) => {
		expect(command(answer)).toBe(expected);
	});

	test.each([["none"], [""], ["volume 50"], ["delete the queue"], ["skip?!maybe"]])(
		"%p is no command",
		(answer) => {
			expect(command(answer)).toBeNull();
		},
	);
});

describe("who reads the command", () => {
	test("the model, when there is one", async () => {
		const asked = answering("play: expectations by Olivia Rodrigo");
		const read = await readIntent("A play expectations by Olro Drigo.", "en", MODEL);
		expect(read.by).toBe("model");
		expect(read.intent).toEqual({
			command: "play",
			query: "expectations by Olivia Rodrigo",
			language: Language.English,
		});
		expect(asked[0].url).toBe("http://127.0.0.1:8085/v1/chat/completions");
		expect(asked[0].body.model).toBe(DEFAULT_INTENT_MODEL);
		expect(asked[0].body.temperature).toBe(0);
		expect(asked[0].body.messages).toContainEqual({
			role: "user",
			content: "A play expectations by Olro Drigo.",
		});
	});

	test("the model's no is final, even where the words would match", async () => {
		answering("none");
		const read = await readIntent("stop talking about it, skip school", "en", MODEL);
		expect(read).toEqual({ intent: null, by: "model" });
	});

	test("it answers in the language that was heard", async () => {
		answering("skip");
		const read = await readIntent("次の曲", "ja", MODEL);
		expect(read.intent?.language).toBe(Language.Japanese);
	});

	test("the words, when the model is not set up", async () => {
		const asked = answering("stop");
		const read = await readIntent("skip this song", "en", {});
		expect(read).toEqual({ intent: { command: "skip", language: Language.English }, by: "words" });
		expect(asked).toHaveLength(0);
	});

	test("the words, when the server is down or says nothing useful", async () => {
		globalThis.fetch = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		expect((await readIntent("skip this song", "en", MODEL)).by).toBe("words");

		globalThis.fetch = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
		expect((await readIntent("pause", "en", MODEL)).intent?.command).toBe("pause");

		globalThis.fetch = (async () => Response.json({ choices: [] })) as unknown as typeof fetch;
		expect((await readIntent("pause", "en", MODEL)).by).toBe("words");
	});
});
