import { describe, expect, test } from "bun:test";
import { Language } from "../lib/interaction";
import type { VoiceIntent } from "../lib/voice/intent";
import { announcement, prepared } from "../lib/voice/announce";

/** What the bot says aloud as it acts on a voice command. */

function said(intent: VoiceIntent) {
	return announcement(intent);
}

const en = Language.English;

describe("what is said for each command", () => {
	test.each([
		[{ command: "skip", language: en }, "Skipping."],
		[{ command: "skip", language: en, options: { amount: 3 } }, "Skipping 3 songs."],
		[{ command: "skip", language: en, options: { amount: 1 } }, "Skipping."],
		[{ command: "pause", language: en }, "Paused."],
		[{ command: "play", query: "bad guy", language: en }, "Playing bad guy."],
		[{ command: "play", query: "bad guy", language: en, options: { next: true } }, "Playing bad guy next."],
		[{ command: "volume", language: en, options: { volume: 40 } }, "Volume 40 percent."],
		[{ command: "loop", language: en }, "Switching the loop."],
		[{ command: "loop", language: en, options: { enabled: true } }, "Looping this song."],
		[{ command: "loop", language: en, options: { enabled: false } }, "Loop off."],
		[{ command: "remove", language: en, options: { index: 2 } }, "Removing song 2."],
		[{ command: "relocate", language: en, options: { position: "1:20" } }, "Jumping to 1:20."],
		[{ command: "disconnect", language: en }, "Leaving the channel."],
	] as [VoiceIntent, string][])("%p", (intent, expected) => {
		expect(said(intent)).toEqual({ text: expected, language: "en" });
	});
});

describe("in a language the speech model has", () => {
	test("Chinese is answered in Chinese", () => {
		expect(said({ command: "pause", language: Language.TraditionalChinese })).toEqual({
			text: "已暫停。",
			language: "zh",
		});
		expect(said({ command: "play", query: "晴天", language: Language.TraditionalChinese }).text).toBe(
			"播放晴天。",
		);
	});

	test("Japanese and Korean are answered in English", () => {
		expect(said({ command: "skip", language: Language.Japanese })).toEqual({ text: "Skipping.", language: "en" });
		expect(said({ command: "skip", language: Language.Korean })).toEqual({ text: "Skipping.", language: "en" });
	});
});

describe("the phrases kept ready", () => {
	const phrases = prepared();

	test("every fixed phrase, in both languages", () => {
		expect(phrases).toContainEqual({ text: "Skipping.", language: "en" });
		expect(phrases).toContainEqual({ text: "Loop off.", language: "en" });
		expect(phrases).toContainEqual({ text: "已暫停。", language: "zh" });
		expect(phrases.filter((phrase) => phrase.language === "en").length).toBe(
			phrases.filter((phrase) => phrase.language === "zh").length,
		);
	});

	test("none with a song or a number left to fill in", () => {
		expect(phrases.some((phrase) => phrase.text.includes("{"))).toBe(false);
		expect(phrases.some((phrase) => /VOICE_SAY/i.test(phrase.text))).toBe(false);
	});
});
