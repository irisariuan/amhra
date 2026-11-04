import { afterEach, describe, expect, test } from "bun:test";
import { SlashCommandBuilder } from "discord.js";
import { type Command, Language } from "../lib/interaction";
import { languagePatterns } from "../lib/language";
import {
	catalogue,
	DEFAULT_INTENT_MODEL,
	intentFrom,
	intentPrompt,
	intentsFrom,
	quickIntent,
	MAX_ACTIONS,
	MAX_SEARCHES,
	MAX_SPOKEN,
	readIntent,
	searchResults,
} from "../lib/voice/intentModel";
import { heardAs, pinnedLanguage, rankedLanguages, speaksIt } from "../lib/voice/voiceSetting";
import type { YouTubeVideo } from "../lib/youtube";

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
	mix: command((b) =>
		b
			.setName("mix")
			.setDescription("Play songs on top of the queue")
			.addSubcommand((s) =>
				s
					.setName("add")
					.setDescription("Play a song alongside")
					.addStringOption((o) => o.setName("search").setDescription("Search").setRequired(true))
					.addNumberOption((o) => o.setName("volume").setDescription("Volume").setMinValue(0).setMaxValue(500)),
			)
			.addSubcommand((s) =>
				s
					.setName("remove")
					.setDescription("Stop a mixed-in song")
					.addIntegerOption((o) => o.setName("queue").setDescription("Queue").setMinValue(2).setRequired(true)),
			)
			.addSubcommand((s) => s.setName("list").setDescription("Show what is mixed in")),
	) as unknown as Command<SlashCommandBuilder>,
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
		// Subcommands are offered by name, each with its own options.
		expect(told).toContain('- mix: Manage the queues mixed in over queue 1 (queues 2 and up), each playing at once with its own songs and volume. Give "subcommand" as one of:');
		expect(told).toContain("    add: Play a song alongside");
		expect(told).toContain("        search (text, required): the song or sound to mix in");
		expect(told).toContain("        queue (whole number, 2 to …, required): which queue, by its number, 2 and up");
		expect(told).toContain("    list: Show what is mixed in");
		// Options for fixing things by hand, and commands that are not about
		// the music, are left out.
		expect(told).not.toContain("force (true or false, optional): Skip the cache");
		expect(told).not.toContain("superreset");
	});
});

describe("several things asked for at once", () => {
	const all = (answer: string) => intentsFrom(answer, Language.English, lookup);

	test("a list is done in its order", () => {
		expect(all('[{"command": "skip"}, {"command": "volume", "volume": 40}]')).toEqual([
			{ command: "skip", language: Language.English },
			{ command: "volume", language: Language.English, options: { volume: 40 } },
		]);
	});

	test("one object is a list of one, and none is an empty one", () => {
		expect(all('{"command": "pause"}')).toEqual([{ command: "pause", language: Language.English }]);
		expect(all('{"command": "none"}')).toEqual([]);
		expect(all("[]")).toEqual([]);
		expect(all("I think you mean skip")).toEqual([]);
	});

	test("what is not a command is left out, and the rest still done", () => {
		expect(all('[{"command": "explode"}, "skip", {"command": "pause"}, {"command": "volume"}]')).toEqual([
			{ command: "pause", language: Language.English },
		]);
	});

	test("brackets in a spoken answer do not end the list", () => {
		expect(
			all('<think>[x]</think> Sure: [{"command": "pause"}, {"command": "speak", "text": "Paused [for now] {ok}."}] done'),
		).toEqual([
			{ command: "pause", language: Language.English },
			{ command: "speak", text: "Paused [for now] {ok}.", language: Language.English },
		]);
	});

	test("no more than the most one request may ask for", () => {
		const many = `[${Array(MAX_ACTIONS + 3).fill('{"command": "skip"}').join(", ")}]`;
		expect(all(many)).toHaveLength(MAX_ACTIONS);
	});

	test("a list is not one command", () => {
		expect(read('[{"command": "skip"}]')).toBeNull();
	});

	test("the model is told it may answer with a list", () => {
		expect(intentPrompt(lookup)).toContain('-> [{"command": "skip"}, {"command": "volume", "volume": 40}]');
	});
});

describe("answering aloud", () => {
	test("the model is offered speak and request_input, and told the bot's state", () => {
		const prompt = intentPrompt(lookup, "Volume: 80%");
		expect(prompt).toContain("- speak: Answer them aloud");
		expect(prompt).toContain("- request_input: Ask them something aloud and listen");
		expect(prompt).toContain("The bot right now:\nVolume: 80%");
		expect(intentPrompt(lookup)).not.toContain("The bot right now");
	});

	test("a spoken answer is what to say, in the language heard", () => {
		expect(intentFrom('{"command": "speak", "text": " Three more. "}', Language.Japanese, lookup)).toEqual({
			command: "speak",
			text: "Three more.",
			language: Language.Japanese,
		});
	});

	test("a question back is said and listened after", () => {
		expect(intentFrom('{"command": "request_input", "text": "Which song?"}', Language.English, lookup)).toEqual({
			command: "request_input",
			text: "Which song?",
			language: Language.English,
		});
		expect(read('{"command": "request_input"}')).toBeNull();
	});

	test("a reply that ends the conversation is no action", () => {
		const prompt = intentPrompt(lookup);
		expect(prompt).toContain('"thank you" -> []');
		expect(prompt).toContain('"Ok." -> []');
		expect(intentsFrom("[]", Language.English, lookup)).toEqual([]);
	});

	test("with nothing to say it is no answer, and a long one is cut", () => {
		expect(read('{"command": "speak"}')).toBeNull();
		expect(read('{"command": "speak", "text": "  "}')).toBeNull();
		expect(read('{"command": "speak", "text": 3}')).toBeNull();
		const long = read(`{"command": "speak", "text": "${"a".repeat(MAX_SPOKEN * 2)}"}`);
		expect(long?.command === "speak" && long.text.length).toBe(MAX_SPOKEN);
	});

	test("a reply is read with the state and what was said before", async () => {
		const asked = answering('{"command": "skip", "amount": 2}');
		const history = [
			{ role: "user" as const, content: "what's coming up" },
			{ role: "assistant" as const, content: '{"command": "speak", "text": "Two songs by Adele. Skip them?"}' },
		];
		const reading = await readIntent("yes please", "en", lookup, MODEL, { context: "Queue: 2 songs", history });
		expect(reading.intents).toEqual([{ command: "skip", language: Language.English, options: { amount: 2 } }]);
		expect(reading.answer).toBe('{"command": "skip", "amount": 2}');
		const messages = asked[0].body.messages as { role: string; content: string }[];
		expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
		expect(messages[0].content).toContain("Queue: 2 songs");
		expect(messages.slice(1)).toEqual([...history, { role: "user", content: "yes please" }]);
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
		[
			'{"command": "mix", "subcommand": "add", "search": "rain sounds", "volume": 30}',
			{ command: "mix", subcommand: "add", options: { search: "rain sounds", volume: 30 } },
		],
		[
			'{"command": "mix", "subcommand": "Remove", "queue": 2}',
			{ command: "mix", subcommand: "remove", options: { queue: 2 } },
		],
		['{"command": "mix", "subcommand": "list"}', { command: "mix", subcommand: "list" }],
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
		// A subcommand is needed, must be one there is, and brings its own
		// required options: another subcommand's do not count.
		['{"command": "mix", "search": "rain"}'],
		['{"command": "mix", "subcommand": "shuffle"}'],
		['{"command": "mix", "subcommand": "remove"}'],
		['{"command": "mix", "subcommand": "add", "track": 1}'],
		['{"command": "skip",'],
	])("%p is no command", (answer) => {
		expect(read(answer)).toBeNull();
	});
});

/** A server that gives `answers` in turn, keeping what it was asked. */
function answeringInTurn(...answers: string[]) {
	const asked: { role: string; content: string }[][] = [];
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		asked.push(JSON.parse(String(init.body)).messages);
		const content = answers[Math.min(asked.length - 1, answers.length - 1)];
		return Response.json({ choices: [{ message: { content } }] });
	}) as unknown as typeof fetch;
	return asked;
}

function video(id: string, title: string, channel: string, durationInSec: number): YouTubeVideo {
	return { id, url: `https://www.youtube.com/watch?v=${id}`, title, durationInSec, channel: { name: channel, url: "" }, thumbnails: [] };
}

describe("searching before deciding", () => {
	const found = [
		video("live1977xxx", "Hotel California (Live 1977)", "Eagles", 432),
		video("studioxxxxx", "Hotel California", "Eagles", 391),
	];

	test("the model is offered search", () => {
		expect(intentPrompt(lookup)).toContain("- search: Look songs up on YouTube");
	});

	test("results are numbered, with who, how long and the link", () => {
		expect(searchResults("hotel california live", found)).toBe(
			'Search results for "hotel california live":\n' +
				"1. Hotel California (Live 1977) - Eagles (7:12) https://www.youtube.com/watch?v=live1977xxx\n" +
				"2. Hotel California - Eagles (6:31) https://www.youtube.com/watch?v=studioxxxxx",
		);
		expect(searchResults("nothing", [])).toBe('Search results for "nothing": nothing found.');
		expect(searchResults("long", [video("x", "Mix", "DJ", 3725)])).toContain("(1:02:05)");
	});

	test("it is sent the results, and plays the one it picks", async () => {
		const searched: string[] = [];
		const asked = answeringInTurn(
			'{"command": "search", "search": "hotel california live"}',
			'{"command": "play", "result": 1}',
		);
		const reading = await readIntent("play the live hotel california", "en", lookup, MODEL, {
			search: async (query) => {
				searched.push(query);
				return found;
			},
		});
		expect(searched).toEqual(["hotel california live"]);
		expect(reading.intents).toEqual([
			{ command: "play", query: "https://www.youtube.com/watch?v=live1977xxx", language: Language.English },
		]);
		expect(asked[1].slice(-2)).toEqual([
			{ role: "assistant", content: '{"command": "search", "search": "hotel california live"}' },
			{ role: "user", content: searchResults("hotel california live", found) },
		]);
		// The search and its results are kept, for a reply to pick from.
		expect(reading.turns?.map((turn) => turn.role)).toEqual(["assistant", "user", "assistant"]);
	});

	test("a result is played by its link, whether named by number, link or id", async () => {
		for (const named of ['"result": 1', '"search": "https://www.youtube.com/watch?v=live1977xxx"', '"search": "live1977xxx"']) {
			answeringInTurn('{"command": "search", "search": "hotel california"}', `{"command": "play", ${named}}`);
			const reading = await readIntent("play the live one", "en", lookup, MODEL, { search: async () => found });
			expect(reading.intents).toEqual([
				{ command: "play", query: "https://www.youtube.com/watch?v=live1977xxx", language: Language.English },
			]);
		}
	});

	test("a link it was not shown, or a number past the results, is not played", async () => {
		for (const named of ['"result": 3', '"search": "https://www.youtube.com/watch?v=madeupxxxxx"']) {
			answeringInTurn('{"command": "search", "search": "hotel california"}', `[{"command": "play", ${named}}, {"command": "pause"}]`);
			const reading = await readIntent("play the live one", "en", lookup, MODEL, { search: async () => found });
			expect(reading.intents).toEqual([{ command: "pause", language: Language.English }]);
		}
	});

	test("a reply picks from the results shown before it", async () => {
		answeringInTurn('{"command": "play", "result": 2}');
		const history = [
			{ role: "user" as const, content: "play hotel california" },
			{ role: "assistant" as const, content: '{"command": "search", "search": "hotel california"}' },
			{ role: "user" as const, content: searchResults("hotel california", found) },
			{ role: "assistant" as const, content: '{"command": "request_input", "text": "Live or studio?"}' },
		];
		const reading = await readIntent("the studio one", "en", lookup, MODEL, { history });
		expect(reading.intents).toEqual([
			{ command: "play", query: "https://www.youtube.com/watch?v=studioxxxxx", language: Language.English },
		]);
	});

	test("it searches no more than so many times, then has to decide", async () => {
		const asked = answeringInTurn('[{"command": "skip"}, {"command": "search", "search": "again"}]');
		const reading = await readIntent("find it", "en", lookup, MODEL, { search: async () => [] });
		expect(asked).toHaveLength(MAX_SEARCHES + 1);
		expect(reading.intents).toEqual([{ command: "skip", language: Language.English }]);
	});

	test("a search is never a command run on its own", () => {
		expect(read('{"command": "search", "search": "bad guy"}')).toBeNull();
		expect(intentsFrom('[{"command": "search", "search": "x"}, {"command": "pause"}]', Language.English, lookup)).toEqual([
			{ command: "pause", language: Language.English },
		]);
	});
});

describe("who reads the command", () => {
	test("the model, when there is one", async () => {
		const asked = answering('{"command": "play", "search": "expectations by Olivia Rodrigo"}');
		const reading = await readIntent("A play expectations by Olro Drigo.", "en", lookup, MODEL);
		expect(reading.by).toBe("model");
		expect(reading.intents).toEqual([
			{
				command: "play",
				query: "expectations by Olivia Rodrigo",
				language: Language.English,
			},
		]);
		expect(asked[0].url).toBe("http://127.0.0.1:8085/v1/chat/completions");
		expect(asked[0].body.model).toBe(DEFAULT_INTENT_MODEL);
		expect(asked[0].body.temperature).toBe(0);
		expect(asked[0].body.messages).toContainEqual({
			role: "user",
			content: "A play expectations by Olro Drigo.",
		});
	});

	test("it can have them heard again, in a language it has to name, once", async () => {
		const answers = ['{"command": "retranscribe", "language": "en"}', '{"command": "skip"}'];
		const sent: { role: string; content: string }[][] = [];
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			sent.push(JSON.parse(String(init.body)).messages);
			return Response.json({ choices: [{ message: { content: answers.shift() } }] });
		}) as unknown as typeof fetch;
		const asked: string[] = [];
		const reading = await readIntent("스킵 더 송", "ko", lookup, MODEL, {
			retranscribe: async (language) => {
				asked.push(language);
				return { text: "skip the song", lang: "en" };
			},
		});
		expect(asked).toEqual(["en"]);
		expect(reading.intents[0]).toMatchObject({ command: "skip", language: Language.English });
		expect(reading.heard).toEqual({ text: "skip the song", lang: "en" });
		expect(sent[1]?.at(-1)?.content).toBe('Heard again in en: "skip the song"');
		expect(sent[0]?.[0]?.content).toContain("yue for Chinese (Cantonese)");
	});

	test("hearing again without a language, or when it cannot be done, is no action", async () => {
		answering('{"command": "retranscribe"}');
		let heard = 0;
		const retranscribe = async () => {
			heard++;
			return null;
		};
		expect(await readIntent("gibberish", "en", lookup, MODEL, { retranscribe })).toMatchObject({ intents: [], by: "model" });
		answering('{"command": "retranscribe", "language": "xx"}');
		expect((await readIntent("gibberish", "en", lookup, MODEL, { retranscribe })).intents).toEqual([]);
		expect(heard).toBe(0);
		answering('{"command": "retranscribe", "language": "ja"}');
		expect((await readIntent("gibberish", "en", lookup, MODEL)).intents).toEqual([]);
		const prompt = (await import("../lib/voice/intentModel")).intentPrompt(lookup);
		expect(prompt).not.toContain("retranscribe");
		// It keeps asking: it is asked once, and that answer is its last.
		expect((await readIntent("gibberish", "en", lookup, MODEL, { retranscribe })).intents).toEqual([]);
		expect(heard).toBe(1);
	});

	describe("said plainly, nothing asks the model", () => {
		const quick = (text: string, lang: string | null = "en") => quickIntent(text, lang, lookup);
		const cases: [string, string | null, Record<string, unknown>][] = [
			["Play shape of you.", "en", { command: "play", query: "shape of you", language: Language.English }],
			["Amra, play bad guy please", "en", { command: "play", query: "bad guy" }],
			["I'm, play bad guy", "en", { command: "play", query: "bad guy" }],
			["Ehara skip.", "en", { command: "skip" }],
			["skip this song", "en", { command: "skip" }],
			["next", "en", { command: "skip" }],
			["skip 2 songs", "en", { command: "skip", options: { amount: 2 } }],
			["set the volume to 40", "en", { command: "volume", options: { volume: 40 } }],
			["Play.", "en", { command: "resume" }],
			["pause the music", "en", { command: "pause" }],
			// As Qwen3-ASR wrote them, from real speech.
			["播放《晴天》。", "zh", { command: "play", query: "晴天" }],
			["播放《晴天》，唔该。", "yue", { command: "play", query: "晴天" }],
			["次の曲。", "ja", { command: "skip", language: Language.Japanese }],
			["Skip the song.", "en", { command: "skip" }],
			["次の曲", "ja", { command: "skip", language: Language.Japanese }],
			["晴天を再生して", "ja", { command: "play", query: "晴天", language: Language.Japanese }],
			["音量を40にして", "ja", { command: "volume", options: { volume: 40 } }],
			["晴天 재생해줘", "ko", { command: "play", query: "晴天", language: Language.Korean }],
			["볼륨 40", "ko", { command: "volume", options: { volume: 40 } }],
			["다음 곡", "ko", { command: "skip", language: Language.Korean }],
			["播放晴天", "zh", { command: "play", query: "晴天", language: Language.TraditionalChinese }],
			["播放晴天", "yue", { command: "play", query: "晴天", language: Language.TraditionalChinese }],
			["下一首", "zh", { command: "skip" }],
			["暂停", "zh", { command: "pause" }],
			["請暫停", "yue", { command: "pause" }],
			// English words, heard in another language, answer in that one.
			["skip", "ja", { command: "skip", language: Language.Japanese }],
		];
		for (const [text, lang, expected] of cases) {
			test(`${text} [${lang}]`, () => {
				const reading = quick(text, lang);
				expect(reading?.by).toBe("pattern");
				expect(reading?.intents).toHaveLength(1);
				expect(reading?.intents[0]).toMatchObject(expected);
				expect(reading?.turns?.[0]?.role).toBe("assistant");
			});
		}

		for (const text of [
			"I'll play football later",
			"stop talking about it",
			"can you play something by olivia",
			"play it again",
			"play the live version of hotel california",
			"play bad guy and put it on repeat",
			"play bad guy next",
			"play the second one",
			"skip this and turn it down to 40",
			"what song is this",
			"skip?",
			"volume up",
			"set the volume to 900",
			"player",
			"don't, skip",
			"Stop. Play hello",
			"晴天をライブで再生して",
			"播放晴天然後暫停",
			"그거 재생해줘",
			"",
		]) {
			test(`goes to the model: ${JSON.stringify(text)}`, () => {
				expect(quick(text)).toBeNull();
			});
		}

		test("the answer goes in the language they chose, not the one heard", () => {
			expect(quickIntent("skip", "en", lookup, "ja")?.intents[0]?.language).toBe(Language.Japanese);
			expect(quickIntent("次の曲", "ja", lookup, "en")?.intents[0]?.language).toBe(Language.English);
			expect(quickIntent("播放晴天", "zh", lookup, "ko")?.intents[0]).toMatchObject({
				query: "晴天",
				language: Language.Korean,
			});
		});

		test("a phrase is data: a new one needs no code", () => {
			const patterns = languagePatterns(Language.English);
			const said = patterns?.commands?.pause;
			said?.push("hold on");
			try {
				expect(quick("hold on")?.intents[0]).toMatchObject({ command: "pause" });
			} finally {
				said?.pop();
			}
		});

		test("a command the bot does not have is no match", () => {
			expect(quickIntent("skip", "en", () => undefined)).toBeNull();
		});
	});

	test("the language they chose to be answered in holds, whatever was heard", async () => {
		answering('{"command": "speak", "text": "三首。"}');
		let prompt = "";
		const fetched = globalThis.fetch;
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			prompt = JSON.parse(String(init.body)).messages[0].content;
			return fetched(url, init);
		}) as unknown as typeof fetch;
		const reading = await readIntent("how many songs are left", "en", lookup, MODEL, { answerIn: "yue" });
		expect(reading.intents[0]?.language).toBe(Language.TraditionalChinese);
		expect(prompt).toContain("answered in Chinese (Cantonese)");

		// Hearing them again in another language does not change it.
		const answers = ['{"command": "retranscribe", "language": "ko"}', '{"command": "skip"}'];
		globalThis.fetch = (async () =>
			Response.json({ choices: [{ message: { content: answers.shift() } }] })) as unknown as typeof fetch;
		const again = await readIntent("gibberish", "en", lookup, MODEL, {
			answerIn: "ja",
			retranscribe: async () => ({ text: "스킵", lang: "ko" }),
		});
		expect(again.intents[0]).toMatchObject({ command: "skip", language: Language.Japanese });

		// Nor does the fallback, with no model to read it.
		globalThis.fetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
		const fallback = await readIntent("pause", "en", lookup, MODEL, { answerIn: "ko" });
		expect(fallback).toMatchObject({ by: "fallback", intents: [{ command: "pause", language: Language.Korean }] });
	});

	test("without a choice the model is told nothing about it", () => {
		expect(intentPrompt(lookup)).not.toContain("chose to be answered");
		expect(intentPrompt(lookup, undefined, true)).not.toContain("languages they speak");
	});

	test("the model is given the languages they speak, in their order, to choose from", async () => {
		const asked: string[] = [];
		answering('{"command": "skip"}');
		const fetched = globalThis.fetch;
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			asked.push(JSON.parse(String(init.body)).messages[0].content);
			return fetched(url, init);
		}) as unknown as typeof fetch;
		await readIntent("gibberish", "ko", lookup, MODEL, {
			speaks: ["en", "yue", "zh", "ja", "ko"],
			retranscribe: async () => null,
		});
		expect(asked[0]).toContain(
			"the likeliest first: en (English) > yue (Chinese (Cantonese) 廣東話) > zh (Chinese (Mandarin) 普通話) > ja (Japanese 日本語) > ko (Korean 한국어).",
		);
		expect(asked[0]).toContain("Choose by the languages they speak");
		// Told even where it cannot have them heard again: it helps to read them.
		const without = intentPrompt(lookup, undefined, false, undefined, ["ja"]);
		expect(without).toContain("the likeliest first: ja (Japanese 日本語).");
		expect(without).not.toContain("Choose by the languages");
	});

	describe("the languages someone speaks", () => {
		test("their choices become a list in order, without repeats", () => {
			expect(rankedLanguages(["en", "yue", null, "zh", "en"], "auto")).toEqual(["en", "yue", "zh"]);
			expect(rankedLanguages(["auto", "yue", null, null, null], "auto")).toEqual([]);
			expect(rankedLanguages(["xx", "ja"], "auto")).toEqual(["ja"]);
		});

		test("the recogniser is told only when there is one", () => {
			expect(pinnedLanguage()).toBeNull();
			expect(pinnedLanguage(["yue"])).toBe("yue");
			expect(pinnedLanguage(["en", "yue"])).toBeNull();
		});

		test("a guess at Chinese is the one of the two they speak, the first if both", () => {
			expect(heardAs("zh", ["en", "yue", "zh"])).toBe("yue");
			expect(heardAs("yue", ["zh", "yue"])).toBe("zh");
			expect(heardAs("yue", ["en"])).toBe("yue");
			expect(heardAs("en", ["yue"])).toBe("en");
			expect(heardAs(null, ["yue"])).toBeNull();
		});

		test("a language they did not list is not one they speak", () => {
			expect(speaksIt("ko", ["en", "yue"])).toBe(false);
			expect(speaksIt("en", ["en", "yue"])).toBe(true);
			expect(speaksIt("ko")).toBe(true);
			expect(speaksIt(null, ["en"])).toBe(true);
		});
	});

	test("the model's no is final, even where the fallback would match", async () => {
		answering('{"command": "none"}');
		const reading = await readIntent("stop talking about it, skip school", "en", lookup, MODEL);
		expect(reading).toMatchObject({ intents: [], by: "model", answer: '{"command": "none"}' });
	});

	test("it answers in the language that was heard", async () => {
		answering('{"command": "skip"}');
		const reading = await readIntent("次の曲", "ja", lookup, MODEL);
		expect(reading.intents[0]?.language).toBe(Language.Japanese);
	});

	test("the fallback, when the model is not set up", async () => {
		const asked = answering('{"command": "stop"}');
		const reading = await readIntent("skip this song", "en", lookup, {});
		expect(reading).toEqual({
			intents: [{ command: "skip", language: Language.English }],
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
		expect((await readIntent("pause", "en", lookup, MODEL)).intents[0]?.command).toBe("pause");

		globalThis.fetch = (async () => Response.json({ choices: [] })) as unknown as typeof fetch;
		expect((await readIntent("pause", "en", lookup, MODEL)).by).toBe("fallback");
	});
});
