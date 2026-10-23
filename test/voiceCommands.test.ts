import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GuildMember, SendableChannels } from "discord.js";
import type { CustomClient } from "../lib/custom";
import { guildSetting, setGuildSetting } from "../lib/guildSetting";
import { setUserSetting, userSetting } from "../lib/userSetting";
import { Language } from "../lib/interaction";
import { languageText } from "../lib/language";
import type { Setting } from "../lib/setting";
import type { Command } from "../lib/interaction";
import { voiceInteraction } from "../lib/voice/voiceInteraction";
import {
	collectsWakeClips,
	voiceCommandArgs,
	voiceTimings,
	WAKE_CLIPS_DIR,
} from "../lib/voice/voiceSetting";

// The player can't be loaded here (it reads data/setting.json as it is
// imported), and the handlers below only ask it whether anything is playing.
// Nothing is.
mock.module("../lib/voice/core", () => ({
	getAudioPlayer: () => null,
	getBotVoiceChannel: () => undefined,
	getConnection: () => undefined,
}));
type Handler = Command<import("discord.js").SlashCommandBuilder>;
const pause: Handler = (await import("../commands/slash/pause")).default;
const resume: Handler = (await import("../commands/slash/continue")).default;

/**
 * The glue between a heard command and the bot: the interaction the slash
 * command handlers are run with, the per-guild switch, and the sidecar's flags.
 */

interface Sent {
	content?: string;
	components?: unknown[];
	allowedMentions?: unknown;
	edits: { content?: string }[];
	deleted: boolean;
}

/** A text channel that records what is sent to it. */
function fakeChannel() {
	const sent: Sent[] = [];
	const channel = {
		id: "text",
		isSendable: () => true,
		send: async (options: Omit<Sent, "edits" | "deleted">) => {
			const message: Sent = { ...options, edits: [], deleted: false };
			sent.push(message);
			return {
				...message,
				edit: async (edit: { content?: string }) => {
					message.edits.push(edit);
					return message;
				},
				delete: async () => {
					message.deleted = true;
				},
			};
		},
	};
	return { channel: channel as unknown as SendableChannels, sent };
}

/** A member in a voice channel, in a guild where the bot is in no call. */
function fakeMember() {
	const voiceChannel = { id: "voice" };
	const guild = {
		id: "guild",
		preferredLocale: "en-US",
		channels: { cache: { find: () => undefined } },
	};
	return {
		id: "42",
		guild,
		user: { id: "42", tag: "someone", bot: false },
		voice: { channel: voiceChannel },
	} as unknown as GuildMember;
}

const client = { player: new Map(), user: { id: "bot" } } as unknown as CustomClient;

describe("a heard command runs the slash command handler", () => {
	test("pause with nothing playing answers as the typed command would", async () => {
		const { channel, sent } = fakeChannel();
		const interaction = voiceInteraction(fakeMember(), channel, {
			command: "pause",
			language: Language.English,
		});
		await pause.execute({ interaction, client, language: Language.English });

		expect(sent).toHaveLength(1);
		const [heading, answer] = (sent[0].content ?? "").split("\n");
		expect(heading).toBe(
			languageText("voice_heard", Language.English, { user: "<@42>", command: "/pause" }),
		);
		expect(answer).toBe(languageText("not_playing", Language.English));
		// The member is named, not pinged.
		expect(sent[0].allowedMentions).toEqual({ parse: [] });
	});

	test("answers in the language the command was said in", async () => {
		const { channel, sent } = fakeChannel();
		const interaction = voiceInteraction(fakeMember(), channel, {
			command: "resume",
			language: Language.Japanese,
		});
		await resume.execute({ interaction, client, language: Language.Japanese });
		expect(sent[0].content).toContain(languageText("not_playing", Language.Japanese));
		expect(sent[0].content).toContain("/再開");
	});
});

describe("the voice interaction", () => {
	test("a subcommand is asked for by name, and shown in the heading", async () => {
		const { channel, sent } = fakeChannel();
		const interaction = voiceInteraction(fakeMember(), channel, {
			command: "mix",
			subcommand: "remove",
			language: Language.English,
			options: { layer: 2 },
		});
		expect(interaction.options.getSubcommand()).toBe("remove");
		expect(interaction.options.getInteger("layer")).toBe(2);
		await interaction.reply({ content: "done" });
		expect(sent[0].content?.split("\n")[0]).toBe(
			languageText("voice_heard", Language.English, { user: "<@42>", command: "/mix remove layer:2" }),
		);
	});

	test("a song request is the play command's search option", () => {
		const { channel } = fakeChannel();
		const interaction = voiceInteraction(fakeMember(), channel, {
			command: "play",
			query: "Bohemian Rhapsody",
			language: Language.English,
		});
		expect(interaction.options.getString("search", true)).toBe("Bohemian Rhapsody");
		expect(interaction.options.getBoolean("force")).toBeNull();
		expect(interaction.options.getInteger("amount")).toBeNull();
	});

	test("options the model gave reach the handler, and are shown", async () => {
		const { channel, sent } = fakeChannel();
		const interaction = voiceInteraction(fakeMember(), channel, {
			command: "skip",
			options: { amount: 2 },
			language: Language.English,
		});
		expect(interaction.options.getInteger("amount")).toBe(2);
		expect(interaction.options.getBoolean("force")).toBeNull();
		await interaction.reply("Skipped");
		expect(sent[0].content).toContain("/skip amount:2");

		const queued = voiceInteraction(fakeMember(), channel, {
			command: "play",
			query: "bad guy",
			options: { next: true },
			language: Language.English,
		});
		expect(queued.options.getString("search", true)).toBe("bad guy");
		expect(queued.options.getBoolean("next")).toBe(true);
	});

	test("a deferred reply is one message, edited into the answer", async () => {
		const { channel, sent } = fakeChannel();
		const interaction = voiceInteraction(fakeMember(), channel, {
			command: "skip",
			language: Language.English,
		});
		const deferred = await interaction.deferReply({ withResponse: true });
		expect(deferred.resource?.message).toBeDefined();
		await interaction.editReply({ content: "Skipped" });
		expect(sent).toHaveLength(1);
		expect(sent[0].edits[0].content).toEndWith("\nSkipped");
		await interaction.followUp("and then some");
		expect(sent[1].content).toBe("and then some");
	});

	test("for someone who asked, the listening message becomes the answer, with their words", async () => {
		const { channel, sent } = fakeChannel();
		const listening = await channel.send({ content: "-# 🎙️ <@42>: listening…" });
		const interaction = voiceInteraction(
			fakeMember(),
			channel,
			{ command: "pause", language: Language.English },
			{ message: listening as never, transcript: "Em, I pre the *song*" },
		);
		await interaction.reply({ content: "Paused!" });

		expect(sent).toHaveLength(1);
		const [heading, answer] = (sent[0].edits[0].content ?? "").split("\n");
		expect(heading).toBe(
			languageText("voice_heard_transcript", Language.English, {
				user: "<@42>",
				// Their words cannot format the message.
				text: "Em, I pre the \\*song\\*",
				command: "/pause",
			}),
		);
		expect(answer).toBe("Paused!");
	});

	test("an ephemeral follow-up is refused, not shown to everyone", async () => {
		const { channel, sent } = fakeChannel();
		const interaction = voiceInteraction(fakeMember(), channel, {
			command: "play",
			query: "x",
			language: Language.English,
		});
		await expect(
			interaction.followUp({ content: "only for you", ephemeral: true }),
		).rejects.toThrow();
		expect(sent).toHaveLength(0);
	});
});

describe("per-guild opt-in", () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	test("off until a guild turns it on, and kept on disk", () => {
		dir = mkdtempSync(join(tmpdir(), "amhra-guild-"));
		const file = join(dir, "guildSetting.json");
		expect(guildSetting("1", file).voiceCommands).toBeUndefined();
		setGuildSetting("1", { voiceCommands: true }, file);
		expect(guildSetting("1", file).voiceCommands).toBe(true);
		expect(guildSetting("2", file).voiceCommands).toBeUndefined();
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "1": { voiceCommands: true } });
	});
});

describe("per-user transcripts", () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	test("off until someone turns it on for themselves", () => {
		dir = mkdtempSync(join(tmpdir(), "amhra-user-"));
		const file = join(dir, "userSetting.json");
		expect(userSetting("42", file).showTranscript).toBeUndefined();
		setUserSetting("42", { showTranscript: true }, file);
		expect(userSetting("42", file).showTranscript).toBe(true);
		expect(userSetting("43", file).showTranscript).toBeUndefined();
		setUserSetting("42", { showTranscript: false }, file);
		expect(userSetting("42", file).showTranscript).toBe(false);
	});

	test("spoken answers stay on until someone turns them off, apart from transcripts", () => {
		dir = mkdtempSync(join(tmpdir(), "amhra-user-"));
		const file = join(dir, "userSetting.json");
		expect(userSetting("42", file).spokenAnswers).toBeUndefined();
		setUserSetting("42", { showTranscript: true }, file);
		setUserSetting("42", { spokenAnswers: false }, file);
		expect(userSetting("42", file)).toEqual({ showTranscript: true, spokenAnswers: false });
	});
});

describe("sidecar flags", () => {
	const base = {} as Setting;

	test("none unless the bot allows voice commands", () => {
		expect(voiceCommandArgs(base)).toEqual([]);
		expect(collectsWakeClips(base)).toBe(false);
	});

	test("the trained wake model, and wake clips unless switched off", () => {
		const allowed = { ...base, VOICE_COMMANDS: true };
		expect(voiceCommandArgs(allowed)).toEqual([
			"--voice-commands",
			"--wake-model",
			"models/voice/kws-emhara",
			"--wake-keywords",
			"training/wake/keywords.txt",
			"--wake-clips",
			WAKE_CLIPS_DIR,
			"--wake-chime",
			"--wake-duck",
			"0.3",
		]);
		expect(
			voiceCommandArgs({ ...allowed, VOICE_COLLECT_WAKE_CLIPS: false }),
		).not.toContain("--wake-clips");
		const quiet = voiceCommandArgs({
			...allowed,
			VOICE_WAKE_CHIME: false,
			VOICE_DUCK_VOLUME: 1,
		});
		expect(quiet).not.toContain("--wake-chime");
		expect(quiet).not.toContain("--wake-duck");
	});

	test("the wake classifier instead of the wake model, when set", () => {
		const allowed = { ...base, VOICE_COMMANDS: true };
		const args = voiceCommandArgs({
			...allowed,
			VOICE_WAKE_CLASSIFIER: "models/voice/wake-classifier",
			VOICE_WAKE_MODEL: "models/voice/other",
		});
		expect(args.slice(0, 3)).toEqual([
			"--voice-commands",
			"--wake-classifier",
			"models/voice/wake-classifier",
		]);
		expect(args).not.toContain("--wake-model");
		expect(args).not.toContain("--wake-keywords");
		expect(args).toContain("--wake-clips");
	});

	test("timings, for the flags and for the running sidecar alike", () => {
		const allowed = { ...base, VOICE_COMMANDS: true };
		expect(voiceTimings(allowed)).toEqual({
			waitForSpeechMs: null,
			endSilenceMs: null,
			maxCaptureMs: null,
		});
		const patient = { ...allowed, VOICE_END_SILENCE_MS: 1200, VOICE_MAX_COMMAND_MS: 0 };
		expect(voiceTimings(patient)).toEqual({
			waitForSpeechMs: null,
			endSilenceMs: 1200,
			maxCaptureMs: null,
		});
		expect(voiceCommandArgs(patient).join(" ")).toContain("--end-silence-ms 1200");
		expect(voiceCommandArgs(patient)).not.toContain("--max-capture-ms");
	});

	test("speech, only when asked for", () => {
		const allowed = { ...base, VOICE_COMMANDS: true };
		expect(voiceCommandArgs(allowed)).not.toContain("--speech");
		const speaking = voiceCommandArgs({ ...allowed, VOICE_SPEECH: true, VOICE_SPEECH_THREADS: 2 });
		expect(speaking.join(" ")).toContain("--speech --speech-threads 2");
		// Not without voice commands, which it answers.
		expect(voiceCommandArgs({ ...base, VOICE_SPEECH: true })).toEqual([]);
	});

	test("where recognition runs, and on how many threads", () => {
		const allowed = { ...base, VOICE_COMMANDS: true };
		const args = voiceCommandArgs({
			...allowed,
			VOICE_RECOGNISER_PROVIDER: "coreml",
			VOICE_RECOGNISER_THREADS: 4,
		});
		expect(args.slice(-4)).toEqual([
			"--recogniser-provider",
			"coreml",
			"--recogniser-threads",
			"4",
		]);
		// Unset, the sidecar's own defaults stand; nonsense is not passed on.
		expect(voiceCommandArgs(allowed)).not.toContain("--recogniser-provider");
		expect(voiceCommandArgs(allowed)).not.toContain("--recogniser-language");
		expect(voiceCommandArgs({ ...allowed, VOICE_LANGUAGE: "auto" })).not.toContain(
			"--recogniser-language",
		);
		expect(voiceCommandArgs({ ...allowed, VOICE_LANGUAGE: "en" })).toContain(
			"--recogniser-language",
		);
		expect(
			voiceCommandArgs({ ...allowed, VOICE_RECOGNISER_THREADS: 0 }),
		).not.toContain("--recogniser-threads");
	});

	test("how long a command may take", () => {
		const allowed = { ...base, VOICE_COMMANDS: true };
		const args = voiceCommandArgs({
			...allowed,
			VOICE_WAIT_FOR_COMMAND_MS: 3000,
			VOICE_END_SILENCE_MS: 900,
			VOICE_MAX_COMMAND_MS: 10000,
		});
		expect(args.slice(-6)).toEqual([
			"--wait-for-speech-ms",
			"3000",
			"--end-silence-ms",
			"900",
			"--max-capture-ms",
			"10000",
		]);
		// Unset, the sidecar's defaults stand.
		expect(voiceCommandArgs(allowed).join(" ")).not.toContain("-ms");
		expect(
			voiceCommandArgs({ ...allowed, VOICE_END_SILENCE_MS: 0 }),
		).not.toContain("--end-silence-ms");
	});
});
