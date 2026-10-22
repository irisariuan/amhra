import { describe, expect, test } from "bun:test";
import { Language } from "../lib/interaction";
import type { VoiceIntent } from "../lib/voice/intent";
import { announcement, foundAnnouncement, prepared, spokenTitle } from "../lib/voice/announce";
import { reportFound, voiceInteraction, type Found } from "../lib/voice/voiceInteraction";

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

describe("play says what the search found", () => {
	const found = (title: string, more: Partial<Found> = {}) =>
		foundAnnouncement({ title, queued: false, next: false, ...more }, en).text;

	test("nothing as it starts: the title is not known yet", () => {
		expect(said({ command: "play", query: "bad guy", language: en })).toBeNull();
	});

	test("started, queued, or next", () => {
		expect(found("Billie Eilish - bad guy")).toBe("Playing Billie Eilish - bad guy.");
		expect(found("Billie Eilish - bad guy", { queued: true })).toBe("Added Billie Eilish - bad guy to the queue.");
		expect(found("Billie Eilish - bad guy", { queued: true, next: true })).toBe("Playing Billie Eilish - bad guy next.");
	});

	test.each([
		["Billie Eilish - bad guy (Official Music Video)", "Billie Eilish - bad guy"],
		["NewJeans (뉴진스) 'Super Shy' Official MV", "NewJeans 'Super Shy' Official MV"],
		["YOASOBI「アイドル」 Official Music Video [4K]", "YOASOBI「アイドル」 Official Music Video"],
		["Lo-fi beats | chill music to study to", "Lo-fi beats"],
		["(Official Audio)", "(Official Audio)"],
	])("%p is said as %p", (title, spoken) => {
		expect(spokenTitle(title)).toBe(spoken);
	});

	test("only a voice command hears what was found", () => {
		const heard: Found[] = [];
		const member = { id: "1", guild: { id: "g", preferredLocale: "en-US" }, user: {} } as never;
		const channel = { id: "c", send: async () => ({}) } as never;
		const intent = { command: "play", query: "bad guy", language: en } as const;
		const voiced = voiceInteraction(member, channel, intent, { onFound: (found) => heard.push(found) });
		reportFound(voiced, { title: "bad guy", queued: false, next: false });
		reportFound(voiceInteraction(member, channel, intent), { title: "other", queued: false, next: false });
		reportFound({}, { title: "typed", queued: false, next: false });
		expect(heard.map((found) => found.title)).toEqual(["bad guy"]);
	});
});

describe("in a language the speech model has", () => {
	test("Chinese is answered in Chinese", () => {
		expect(said({ command: "pause", language: Language.TraditionalChinese })).toEqual({
			text: "已暫停。",
			language: "zh",
		});
		expect(
			foundAnnouncement({ title: "周杰倫 Jay Chou【晴天】", queued: false, next: false }, Language.TraditionalChinese),
		).toEqual({ text: "播放周杰倫 Jay Chou。", language: "zh" });
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
