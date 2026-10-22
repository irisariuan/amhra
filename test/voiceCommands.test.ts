import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GuildMember, SendableChannels } from "discord.js";
import type { CustomClient } from "../lib/custom";
import { guildSetting, setGuildSetting } from "../lib/guildSetting";
import { Language } from "../lib/interaction";
import { languageText } from "../lib/language";
import type { Setting } from "../lib/setting";
import type { Command } from "../lib/interaction";
import { voiceInteraction } from "../lib/voice/voiceInteraction";
import {
	collectsWakeClips,
	voiceCommandArgs,
	WAKE_CLIPS_DIR,
} from "../lib/voice/voiceSetting";

// The player can't be loaded here (ytdl-core's agent does not construct under
// Bun's undici), and the handlers below only ask it whether anything is
// playing. Nothing is.
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
		]);
		expect(
			voiceCommandArgs({ ...allowed, VOICE_COLLECT_WAKE_CLIPS: false }),
		).not.toContain("--wake-clips");
	});
});
