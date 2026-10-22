import { describe, expect, test } from "bun:test";
import { Language } from "../lib/interaction";
import { levenshtein, parseVoiceCommand, withoutName } from "../lib/voice/intent";

/**
 * Reading commands out of what the sidecar transcribed after the wake word.
 *
 * The first cases are real: what came back from a live Discord call with the
 * trained wake model, beside what was actually said. The near misses are what
 * must not move the player, because a false wake followed by chatter is
 * exactly what they look like.
 */

function command(text: string, lang: string | null = "en") {
	const intent = parseVoiceCommand(text, lang);
	if (!intent) return null;
	return intent.command === "play" ? `play: ${intent.query}` : intent.command;
}

describe("transcripts from the live test", () => {
	test.each([
		// "play this song", with nothing new named: carry on with it.
		["how, I pay this song", "resume"],
		["Em, I pre the song", "pause"],
		["I'm, I stop it", "stop"],
		["Amer continue to pay", "resume"],
		["hammer skip this song", "skip"],
		["And how ski this on.", "skip"],
	])("%p", (heard, expected) => {
		expect(command(heard)).toBe(expected);
	});
});

describe("what is left of the name is stripped", () => {
	test.each([
		["Empower pause", "pause"],
		["Amharra, skip", "skip"],
		["Amhra skip this song.", "skip"],
		["Em, stop the music", "stop"],
		["I'm, I resume", "resume"],
		["hammer next song", "skip"],
		["Amara, please pause the song", "pause"],
		["Emhra continue", "resume"],
		["skip", "skip"],
		["Pause.", "pause"],
	])("%p", (heard, expected) => {
		expect(command(heard)).toBe(expected);
	});
});

describe("skipping the part of a video that is not music", () => {
	test.each([
		// What was said, twice, in the live test of this phase.
		["Amhra, skip non-music content", "skipnonmusic"],
		["Empower skip non music content.", "skipnonmusic"],
		["hammer skip the nonmusic part", "skipnonmusic"],
		["Em, skip none music", "skipnonmusic"],
		["skip the intro", "skipnonmusic"],
		// Plain skip is still skip.
		["skip this song", "skip"],
	])("%p", (heard, expected) => {
		expect(command(heard)).toBe(expected);
	});

	test.each([
		["音楽以外をスキップして", "ja"],
		["音楽以外の部分をスキップ", "ja"],
		["음악 아닌 부분 건너뛰어", "ko"],
		["跳过非音乐部分", "zh"],
		["跳過前奏", "zh"],
	])("%p", (heard, lang) => {
		expect(command(heard, lang)).toBe("skipnonmusic");
	});

	test("but not skipping non-music for a reason", () => {
		expect(command("skip non music content tomorrow")).toBeNull();
	});
});

describe("song requests keep the words after the verb", () => {
	test.each([
		["play Bohemian Rhapsody", "play: Bohemian Rhapsody"],
		["Amhra, play Bohemian Rhapsody.", "play: Bohemian Rhapsody"],
		["hammer play never gonna give you up", "play: never gonna give you up"],
		["Em, put on Despacito", "play: Despacito"],
		["how, I play the beatles hey jude", "play: the beatles hey jude"],
		["play", "resume"],
		["play the music", "resume"],
	])("%p", (heard, expected) => {
		expect(command(heard)).toBe(expected);
	});
});

describe("near misses do nothing", () => {
	test.each([
		["how are you doing"],
		["I'm going to stop by later"],
		["and how's the weather today"],
		["stop talking"],
		["skip school tomorrow"],
		["pay me back"],
		["display the queue"],
		["I'm hungry"],
		["Amara is my friend"],
		["what song is this"],
		["can you hear me"],
		["top of the morning"],
		["stip"],
		["I stopped the car"],
		["live this song"],
		["the band will play tonight"],
		[""],
		["Em,"],
	])("%p", (heard) => {
		expect(command(heard)).toBeNull();
	});
});

describe("Japanese", () => {
	test.each([
		["スキップ", "skip"],
		["エムハラ、一時停止して", "pause"],
		["この曲をスキップしてください", "skip"],
		["次の曲", "skip"],
		["止めて", "stop"],
		["再開", "resume"],
		["続けて", "resume"],
		["ボヘミアンラプソディを再生して", "play: ボヘミアンラプソディ"],
		["もののけ姫を流して", "play: もののけ姫"],
		["再生", "resume"],
	])("%p", (heard, expected) => {
		expect(command(heard, "ja")).toBe(expected);
	});

	test.each([["今日は暑いですね"], ["次の駅で降ります"], ["止めてって言ったのに"]])(
		"near miss %p",
		(heard) => {
			expect(command(heard, "ja")).toBeNull();
		},
	);
});

describe("Korean", () => {
	test.each([
		["엠하라, 일시정지", "pause"],
		["다음 곡", "skip"],
		["이 노래 건너뛰어", "skip"],
		["멈춰", "pause"],
		["정지해 줘", "stop"],
		["그만해", "stop"],
		["계속 재생해줘", "resume"],
		["보헤미안 랩소디 틀어줘", "play: 보헤미안 랩소디"],
		["아이유 좋은 날 재생해 줘", "play: 아이유 좋은 날"],
	])("%p", (heard, expected) => {
		expect(command(heard, "ko")).toBe(expected);
	});

	test.each([["오늘 정말 피곤해"], ["나 지금 나가야 돼"], ["다음 주에 보자"]])(
		"near miss %p",
		(heard) => {
			expect(command(heard, "ko")).toBeNull();
		},
	);
});

describe("Chinese", () => {
	test.each([
		["暂停", "pause"],
		["Amhra，跳过这首歌", "skip"],
		["艾姆哈拉，下一首", "skip"],
		["暫停一下", "pause"],
		["继续播放", "resume"],
		["停止", "stop"],
		["停", "stop"],
		["把这首歌跳过", "skip"],
		["播放周杰伦的晴天", "play: 周杰伦的晴天"],
		["播放晴天吧", "play: 晴天"],
		["播放", "resume"],
	])("%p", (heard, expected) => {
		expect(command(heard, "zh")).toBe(expected);
	});

	test.each([["我今天好累"], ["停车场在哪里"], ["你在干什么"], ["下一首歌是什么"]])(
		"near miss %p",
		(heard) => {
			expect(command(heard, "zh")).toBeNull();
		},
	);
});

describe("language", () => {
	test("replies in the language that matched", () => {
		expect(parseVoiceCommand("暂停", "zh")?.language).toBe(Language.TraditionalChinese);
		expect(parseVoiceCommand("skip", "en")?.language).toBe(Language.English);
	});

	test("a wrong or missing language guess still finds the command", () => {
		expect(command("hammer skip this song", "ko")).toBe("skip");
		expect(command("hammer skip this song", null)).toBe("skip");
		expect(command("一時停止して", "en")).toBe("pause");
		expect(command("다음 곡", "yue")).toBe("skip");
	});
});

test("levenshtein", () => {
	expect(levenshtein("pay", "play")).toBe(1);
	expect(levenshtein("ski", "skip")).toBe(1);
	expect(levenshtein("continue", "contiue")).toBe(1);
	expect(levenshtein("", "abc")).toBe(3);
});

describe("what is shown of what was heard", () => {
	test.each([
		// The name said twice: timing cuts the first, this the second.
		["I'm Har, Play some music.", "en", "Play some music."],
		["How, Im how.", "en", ""],
		["Amhra skip this song.", "en", "skip this song."],
		["Empower pause", "en", "pause"],
		// Nothing of the name left: unchanged.
		["skip this song.", "en", "skip this song."],
		["play Bohemian Rhapsody", "en", "play Bohemian Rhapsody"],
		["艾姆哈拉，暂停。", "zh", "暂停。"],
		["Amhra，跳过这首歌", "zh", "跳过这首歌"],
		["エムハラ、一時停止して", "ja", "一時停止して"],
		["暂停", "zh", "暂停"],
	])("%p", (heard, lang, shown) => {
		expect(withoutName(heard, lang)).toBe(shown);
	});
});

