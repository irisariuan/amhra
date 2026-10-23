import { describe, expect, test } from "bun:test";
import type { Turn } from "../lib/voice/intentModel";
import { REMEMBER_FOR_MS, VoiceMemory } from "../lib/voice/voiceMemory";

/** What each member said to the bot lately, for the next request to lean on. */

const said = (text: string, answer: string): Turn[] => [
	{ role: "user", content: text },
	{ role: "assistant", content: answer },
];

describe("VoiceMemory", () => {
	test("recalls what was said, oldest first", () => {
		const memory = new VoiceMemory();
		memory.remember("g:1", said("turn it down to 40", '{"command": "volume", "volume": 40}'), 0);
		memory.remember("g:1", said("skip", '{"command": "skip"}'), 10_000);
		expect(memory.recall("g:1", 20_000).map((turn) => turn.content)).toEqual([
			"turn it down to 40",
			'{"command": "volume", "volume": 40}',
			"skip",
			'{"command": "skip"}',
		]);
		// Recalling leaves it as it was.
		expect(memory.recall("g:1", 20_000)[0].content).toBe("turn it down to 40");
	});

	test("forgets an exchange a minute after it was said", () => {
		const memory = new VoiceMemory();
		memory.remember("g:1", said("skip", "{}"), 0);
		memory.remember("g:1", said("pause", "{}"), 30_000);
		expect(memory.recall("g:1", REMEMBER_FOR_MS + 1).map((turn) => turn.content)).toEqual(["pause", "{}"]);
		expect(memory.recall("g:1", 30_000 + REMEMBER_FOR_MS + 1)).toEqual([]);
	});

	test("follows a change to how long it remembers", () => {
		let forMs = REMEMBER_FOR_MS;
		const memory = new VoiceMemory(() => forMs);
		memory.remember("g:1", said("skip", "{}"), 0);
		expect(memory.recall("g:1", 30_000)).toHaveLength(2);
		forMs = 20_000;
		expect(memory.recall("g:1", 30_000)).toEqual([]);
	});

	test("keeps each member apart", () => {
		const memory = new VoiceMemory();
		memory.remember("g:1", said("skip", "{}"), 0);
		expect(memory.recall("g:2", 0)).toEqual([]);
		expect(memory.recall("h:1", 0)).toEqual([]);
	});

	test("keeps the latest exchanges that fit, whole", () => {
		const memory = new VoiceMemory(REMEMBER_FOR_MS, 4);
		memory.remember("g:1", said("one", "1"), 0);
		// A search makes an exchange of four turns: words, search, results, answer.
		memory.remember(
			"g:1",
			[
				{ role: "user", content: "two" },
				{ role: "assistant", content: "search" },
				{ role: "user", content: "Search results for" },
				{ role: "assistant", content: "2" },
			],
			1,
		);
		memory.remember("g:1", said("three", "3"), 2);
		// The search does not fit beside the latest, and is not cut in half.
		expect(memory.recall("g:1", 3).map((turn) => turn.content)).toEqual(["three", "3"]);
		// The latest alone is kept even when it is more than fits.
		memory.forget("g:1");
		memory.remember("g:1", [...said("a", "1"), ...said("b", "2"), ...said("c", "3")], 4);
		expect(memory.recall("g:1", 5)).toHaveLength(6);
	});
});
