import { afterEach, describe, expect, test } from "bun:test";
import { SlashCommandBuilder } from "discord.js";
import { type Command, Language } from "../lib/interaction";
import {
	catalogue,
	DEFAULT_INTENT_MODEL,
	intentFrom,
	readIntent,
} from "../lib/voice/intentModel";

/**
 * A local model deciding what a voice command asks for, held to the bot's
 * music commands and their options, with the plain fallback behind it when
 * the model is not there.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Slash commands shaped as the real ones are, without what they import. */
function command(build: (builder: SlashCommandBuilder) => SlashCommandBuilder) {
	return { data: build(new SlashCommandBuilder()), execute: () => {} } as unknown as Command<SlashCommandBuilder>;
}
const COMMANDS: Record<string, Command<SlashCommandBuilder>> = {
	play: command((b) =>
		b
			.setName("play")
			.setDescription("Play music")
			.addStringOption((o) => o.setName("search").setDescription("Search").setRequired(true))
			.addBooleanOption((o) => o.setName("force").setDescription("Skip the cache"))
			.addBooleanOption((o) => o.setName("next").setDescription("Add the song to play next"))
			.addNumberOption((o) => o.setName("volume").setDescription("Set volume").setMinValue(0).setMaxValue(500)),
	),
	resume: command((b) => b.setName("resume").setDescription("Resume the song")),
	pause: command((b) => b.setName("pause").setDescription("Pause the music playing")),
	skip: command((b) =>
		b
			.setName("skip")
			.setDescription("Skip the song")
			.addBooleanOption((o) => o.setName("force").setDescription("Force skip"))
			.addIntegerOption((o) => o.setName("amount").setDescription("How many").setMinValue(1)),
	),
	volume: command((b) =>
		b
			.setName("volume")
			.setDescription("Set volume of the bot")
			.addNumberOption((o) =>
				o.setName("volume").setDescription("Volume").setMinValue(0).setMaxValue(500).setRequired(true),
			),
	),
	loop: command((b) =>
		b
			.setName("loop")
			.setDescription("Toggle the loop mode")
			.addBooleanOption((o) => o.setName("enabled").setDescription("Enable or disable")),
	),
	relocate: command((b) =>
		b
			.setName("relocate")
			.setDescription("Set song to play from the wanted position")
			.addStringOption((o) => o.setName("position").setDescription("Position").setRequired(true)),
	),
	// Not about the music: never offered, never taken.
	superreset: command((b) => b.setName("superreset").setDescription("Reset everything")),
};
const lookup = (name: string) => COMMANDS[name];

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

function read(answer: string) {
	return intentFrom(answer, Language.English, lookup);
}

describe("what the model is told", () => {
	test("the music commands there are, with their options and limits", () => {
		const told = catalogue(lookup);
		expect(told).toContain("- skip: Skip the song");
		expect(told).toContain("amount (whole number, 1 to …, optional)");
		expect(told).toContain("volume (number, 0 to 500, required): a percentage");
		expect(told).toContain("- relocate:");
		// Options for fixing things by hand, and commands that are not about
		// the music, are left out.
		expect(told).not.toContain("force (true or false, optional): Skip the cache");
		expect(told).not.toContain("superreset");
	});
});

describe("what the model's answer is taken to mean", () => {
	test.each([
		['{"command": "skip"}', { command: "skip" }],
		['{"command": "Skip"}', { command: "skip" }],
		['{"command": "skip", "amount": 2}', { command: "skip", options: { amount: 2 } }],
		['{"command": "play", "search": "bad guy"}', { command: "play", query: "bad guy" }],
		[
			'{"command": "play", "search": "bad guy", "next": true}',
			{ command: "play", query: "bad guy", options: { next: true } },
		],
		['{"command": "play"}', { command: "resume" }],
		['{"command": "volume", "volume": 40}', { command: "volume", options: { volume: 40 } }],
		['{"command": "volume", "volume": "40"}', { command: "volume", options: { volume: 40 } }],
		['{"command": "loop", "enabled": false}', { command: "loop", options: { enabled: false } }],
		['{"command": "relocate", "position": "1:20"}', { command: "relocate", options: { position: "1:20" } }],
		['<think>\n\n</think>\n\n{"command": "pause"}', { command: "pause" }],
		['Sure: {"command": "pause"} because they said pause', { command: "pause" }],
	])("%p", (answer, expected) => {
		expect(read(answer)).toEqual({ ...expected, language: Language.English } as never);
	});

	test("options that do not fit are left out", () => {
		// Below the minimum, a fraction where a whole number goes, the wrong
		// type, an option the command does not have, one for fixing by hand.
		expect(read('{"command": "skip", "amount": 0}')).toEqual({ command: "skip", language: Language.English });
		expect(read('{"command": "skip", "amount": 1.5, "loud": true}')).toEqual({
			command: "skip",
			language: Language.English,
		});
		expect(read('{"command": "loop", "enabled": "yes"}')).toEqual({ command: "loop", language: Language.English });
		expect(read('{"command": "play", "search": "x", "force": true}')).toEqual({
			command: "play",
			query: "x",
			language: Language.English,
		});
	});

	test.each([
		['{"command": "none"}'],
		[""],
		["skip"],
		['{"command": "superreset"}'],
		['{"command": "delete everything"}'],
		// Required and missing, or out of range.
		['{"command": "volume"}'],
		['{"command": "volume", "volume": 9000}'],
		['{"command": "relocate"}'],
		['{"command": "skip",'],
	])("%p is no command", (answer) => {
		expect(read(answer)).toBeNull();
	});
});

describe("who reads the command", () => {
	test("the model, when there is one", async () => {
		const asked = answering('{"command": "play", "search": "expectations by Olivia Rodrigo"}');
		const reading = await readIntent("A play expectations by Olro Drigo.", "en", lookup, MODEL);
		expect(reading.by).toBe("model");
		expect(reading.intent).toEqual({
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

	test("the model's no is final, even where the fallback would match", async () => {
		answering('{"command": "none"}');
		const reading = await readIntent("stop talking about it, skip school", "en", lookup, MODEL);
		expect(reading).toEqual({ intent: null, by: "model" });
	});

	test("it answers in the language that was heard", async () => {
		answering('{"command": "skip"}');
		const reading = await readIntent("次の曲", "ja", lookup, MODEL);
		expect(reading.intent?.language).toBe(Language.Japanese);
	});

	test("the fallback, when the model is not set up", async () => {
		const asked = answering('{"command": "stop"}');
		const reading = await readIntent("skip this song", "en", lookup, {});
		expect(reading).toEqual({
			intent: { command: "skip", language: Language.English },
			by: "fallback",
		});
		expect(asked).toHaveLength(0);
	});

	test("the fallback, when the server is down or says nothing useful", async () => {
		globalThis.fetch = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		expect((await readIntent("skip this song", "en", lookup, MODEL)).by).toBe("fallback");

		globalThis.fetch = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
		expect((await readIntent("pause", "en", lookup, MODEL)).intent?.command).toBe("pause");

		globalThis.fetch = (async () => Response.json({ choices: [] })) as unknown as typeof fetch;
		expect((await readIntent("pause", "en", lookup, MODEL)).by).toBe("fallback");
	});
});
