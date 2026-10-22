import { describe, expect, test } from "bun:test";
import { Language } from "../lib/interaction";
import { parseVoiceCommand } from "../lib/voice/intent";

/**
 * The fallback for when no model reads the command: a command's own name,
 * said first, after at most two words of whatever became of the bot's name.
 */

function command(text: string, lang: string | null = "en") {
	const intent = parseVoiceCommand(text, lang);
	if (!intent) return null;
	return intent.command === "play" ? `play: ${intent.query}` : intent.command;
}

describe("a command's name, said first", () => {
	test.each([
		["skip", "skip"],
		["Skip.", "skip"],
		["skip this song", "skip"],
		["pause", "pause"],
		["resume", "resume"],
		["stop the music", "stop"],
		["disconnect", "disconnect"],
		["Skip non music content.", "skipnonmusic"],
		["skip non-music", "skipnonmusic"],
	])("%p", (heard, expected) => {
		expect(command(heard)).toBe(expected);
	});
});

describe("after what became of the bot's name", () => {
	test.each([
		["Ehara, skip", "skip"],
		["I'm Har, pause.", "pause"],
		["A play expectations", "play: expectations"],
	])("%p", (heard, expected) => {
		expect(command(heard)).toBe(expected);
	});
});

describe("play takes the rest as the song", () => {
	test.each([
		["play Bohemian Rhapsody", "play: Bohemian Rhapsody"],
		["Play, we can't be friends.", "play: we can't be friends"],
		["play", "resume"],
		["Play.", "resume"],
	])("%p", (heard, expected) => {
		expect(command(heard)).toBe(expected);
	});
});

describe("each language's own command names", () => {
	test.each([
		["スキップ", "ja", "skip"],
		["一時停止して", "ja", "pause"],
		["일시정지", "ko", "pause"],
		["재생 아이유 좋은 날", "ko", "play: 아이유 좋은 날"],
		["暫停", "zh", "pause"],
		["播放晴天", "zh", "play: 晴天"],
	])("%p", (heard, lang, expected) => {
		expect(command(heard, lang)).toBe(expected);
	});

	test("answering in the language the name was in", () => {
		expect(parseVoiceCommand("スキップ", "en")?.language).toBe(Language.Japanese);
		expect(parseVoiceCommand("skip", "en")?.language).toBe(Language.English);
		// An English name heard in Korean is answered in Korean.
		expect(parseVoiceCommand("skip", "ko")?.language).toBe(Language.Korean);
	});
});

describe("anything else is nothing", () => {
	test.each([
		["how are you doing"],
		["I stopped the car"],
		["player one"],
		["I'm going to stop by later"],
		["the band will play tonight"],
		[""],
		["Em,"],
	])("%p", (heard) => {
		expect(command(heard)).toBeNull();
	});
});
