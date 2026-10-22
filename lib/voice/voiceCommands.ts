import {
	escapeMarkdown,
	type Guild,
	type GuildMember,
	type Message,
	type SlashCommandBuilder,
	type VoiceState,
} from "discord.js";
import type { CustomClient } from "../custom";
import { type Command, Language } from "../interaction";
import { languageText, parseLocale } from "../language";
import { dcb, globalApp } from "../misc";
import { readSetting } from "../setting";
import { userSetting } from "../userSetting";
import { announcement, prepared } from "./announce";
import { readIntent } from "./intentModel";
import { getNativeConnection } from "./native";
import { type SidecarEvent, sidecar } from "./sidecar";
import { voiceInteraction } from "./voiceInteraction";
import { collectsWakeClips, guildListens, speaksAnswers } from "./voiceSetting";

/**
 * Turns what the sidecar heard after the wake word into the bot's own
 * commands, and tells people they are being listened to.
 *
 * A heard command runs the same slash command handler a typed one would, with
 * an interaction that answers in the channel instead of to a click. So every
 * check stays the one the handler already makes — same voice channel, nothing
 * playing, the skip vote — and a voice command can do nothing a typed one
 * could not.
 */

/** A notice repeated sooner than this in the same channel is noise. */
const NOTICE_EVERY_MS = 60 * 60 * 1000;
/** Members who join within this of each other are told in one message. */
const NEWCOMER_BATCH_MS = 3_000;
/** And newcomers are told at most this often per guild. */
const NEWCOMER_EVERY_MS = 5 * 60 * 1000;
/** A "didn't catch that" is cleared away after this. */
const NOTHING_HEARD_FOR_MS = 15_000;

type Lookup = (name: string) => Command<SlashCommandBuilder> | undefined;

let bound: CustomClient | null = null;

/**
 * Route utterances into commands and announce listening. Idempotent; call it
 * with the sidecar bound, before login.
 */
export function bindVoiceCommands(client: CustomClient, lookup: Lookup) {
	if (bound === client) return;
	bound = client;
	const bus = sidecar();

	bus.on("utterance", (payload: Extract<SidecarEvent, { type: "utterance" }>) => {
		onUtterance(client, lookup, payload).catch((error) =>
			globalApp.err("Voice command failed", error),
		);
	});
	bus.on("woke", (payload: Extract<SidecarEvent, { type: "woke" }>) => {
		onWoke(client, payload).catch((error) =>
			globalApp.err("Voice transcript failed", error),
		);
	});
	bus.on("nothingHeard", (payload: Extract<SidecarEvent, { type: "nothingHeard" }>) => {
		onNothingHeard(client, payload).catch((error) =>
			globalApp.err("Voice transcript failed", error),
		);
	});

	// Every new voice session in a guild that listens says so in the channel.
	bus.on("ready", (payload: { guildId: string }) => {
		if (!guildListens(payload.guildId)) return;
		const channelId = getNativeConnection(payload.guildId)?.channelId;
		const channel = channelId ? client.channels.cache.get(channelId) : null;
		if (channel?.isVoiceBased()) {
			announceListening(channel.guild, channel.id).catch(() => {});
		}
	});

	// The phrases always said the same are made ready once per sidecar, so
	// saying them never waits on the speech model.
	const prepare = () => {
		if (speaksAnswers()) bus.send({ type: "prepareSpeech", phrases: prepared() });
	};
	bus.on("hello", prepare);
	if (bus.running) prepare();

	client.on("voiceStateUpdate", (before, after) => newcomer(before, after));
}

/**
 * "Listening…" messages for people who asked to see what was heard, posted on
 * the wake and filled in when the words arrive. Keyed by guild and user, and
 * held as the promise of the message: the words can come back before the
 * post has.
 */
const listening = new Map<string, Promise<Message | null>>();

function listeningKey(guildId: string, userId: string) {
	return `${guildId}:${userId}`;
}

/** The member who spoke, if they are someone the bot answers. */
async function speaker(client: CustomClient, guildId: string, userId: string) {
	// The sidecar should not have heard a guild that turned this off, but the
	// switch is checked here too: a `setListen` may still be in flight.
	if (!guildListens(guildId)) return null;
	if (readSetting().BANNED_IDS?.includes(userId)) return null;
	const guild = client.guilds.cache.get(guildId);
	const member = await guild?.members.fetch(userId).catch(() => null);
	if (!guild || !member || member.user.bot || !member.voice.channel) return null;
	return { guild, member };
}

async function onWoke(
	client: CustomClient,
	{ guildId, userId }: Extract<SidecarEvent, { type: "woke" }>,
) {
	if (!userSetting(userId).showTranscript) return;
	const key = listeningKey(guildId, userId);
	const post = (async () => {
		const found = await speaker(client, guildId, userId);
		const channel = found && replyChannel(client, found.guild, found.member);
		if (!found || !channel) return null;
		return channel
			.send({
				content: languageText("voice_transcript_listening", guildLanguage(found.guild), {
					user: `<@${userId}>`,
				}),
				allowedMentions: { parse: [] },
			})
			.catch(() => null);
	})();
	listening.set(key, post);
}

/** The wake's "listening…", if one was posted, no longer waiting for words. */
function takeListening(guildId: string, userId: string) {
	const key = listeningKey(guildId, userId);
	const post = listening.get(key);
	listening.delete(key);
	return post ?? Promise.resolve(null);
}

async function onNothingHeard(
	client: CustomClient,
	{ guildId, userId }: Extract<SidecarEvent, { type: "nothingHeard" }>,
) {
	const message = await takeListening(guildId, userId);
	if (!message) return;
	const guild = client.guilds.cache.get(guildId);
	await message
		.edit({
			content: languageText(
				"voice_transcript_nothing",
				guild ? guildLanguage(guild) : Language.English,
				{ user: `<@${userId}>` },
			),
			allowedMentions: { parse: [] },
		})
		.catch(() => {});
	setTimeout(() => message.delete().catch(() => {}), NOTHING_HEARD_FOR_MS).unref?.();
}

async function onUtterance(
	client: CustomClient,
	lookup: Lookup,
	{ guildId, userId, text, lang }: Extract<SidecarEvent, { type: "utterance" }>,
) {
	const waiting = await takeListening(guildId, userId);
	const found = await speaker(client, guildId, userId);
	if (!found) return;
	const { guild, member } = found;
	const showTranscript = userSetting(userId).showTranscript === true;

	const { intent, by } = await readIntent(text, lang, lookup);
	// What was said stays out of the log, as it does in the sidecar's, unless
	// the owner is tuning the matching and asked for it.
	const heard = readSetting().VOICE_LOG_TRANSCRIPTS
		? `: [${lang ?? "?"}] ${JSON.stringify(text)} (read by the ${by})`
		: "";
	const command = intent && lookup(intent.command);
	const channel = replyChannel(client, guild, member);

	if (!intent || !command) {
		dcb.log(`(Guild ID: ${guildId}) Heard the name, then no command${heard}`);
		if (showTranscript) {
			const content = languageText("voice_transcript_unmatched", guildLanguage(guild), {
				user: `<@${userId}>`,
				text: escapeMarkdown(text),
			});
			const answer = { content, allowedMentions: { parse: [] } };
			if (waiting) await waiting.edit(answer).catch(() => {});
			else await channel?.send(answer).catch(() => {});
		}
		return;
	}
	if (!channel) {
		globalApp.warn(`(Guild ID: ${guildId}) Nowhere to answer a voice command`);
		return;
	}

	dcb.log(
		`(Guild ID: ${guildId}) ${member.user.tag} said voice command ${intent.command}${heard}`,
	);
	// Said as it starts, not once it is done: "Leaving the channel" after
	// leaving would never be heard. A command that is then refused says why
	// in the chat.
	if (speaksAnswers()) sidecar().send({ type: "speak", guildId, ...announcement(intent) });
	await command.execute({
		interaction: voiceInteraction(member, channel, intent, {
			message: waiting,
			transcript: showTranscript ? text : undefined,
		}),
		client,
		language: intent.language,
	});
}

/**
 * Where a heard command answers: wherever the player already talks, or else
 * the voice channel's own chat, which everyone in the call can see.
 */
function replyChannel(client: CustomClient, guild: Guild, member: GuildMember) {
	const playerChannel = client.player.get(guild.id)?.channel;
	if (playerChannel?.isSendable()) return playerChannel;
	const voice = member.voice.channel;
	return voice?.isSendable() ? voice : null;
}

const announced = new Map<string, { channelId: string; at: number }>();

/**
 * Say in the voice channel's chat that the bot is listening for its name.
 * `force` says it again even if it was said there recently, for a guild that
 * has just turned it on.
 */
export async function announceListening(guild: Guild, channelId: string, force = false) {
	const last = announced.get(guild.id);
	if (
		!force &&
		last?.channelId === channelId &&
		Date.now() - last.at < NOTICE_EVERY_MS
	) {
		return;
	}
	const channel = guild.channels.cache.get(channelId);
	if (!channel?.isSendable()) return;
	announced.set(guild.id, { channelId, at: Date.now() });
	await channel.send({
		content: languageText(
			collectsWakeClips() ? "voice_listening_notice_clips" : "voice_listening_notice",
			guildLanguage(guild),
		),
		allowedMentions: { parse: [] },
	});
}

const newcomers = new Map<string, { members: Set<string>; timer: ReturnType<typeof setTimeout> }>();
const toldNewcomers = new Map<string, number>();

/** Someone joined the channel the bot listens in: tell them, in batches. */
function newcomer(before: VoiceState, after: VoiceState) {
	const guildId = after.guild.id;
	if (!after.channelId || before.channelId === after.channelId) return;
	if (after.member?.user.bot) return;
	if (getNativeConnection(guildId)?.channelId !== after.channelId) return;
	if (!guildListens(guildId)) return;
	if (Date.now() - (toldNewcomers.get(guildId) ?? 0) < NEWCOMER_EVERY_MS) return;

	const pending = newcomers.get(guildId);
	if (pending) {
		pending.members.add(after.id);
		return;
	}
	const members = new Set([after.id]);
	const channelId = after.channelId;
	const timer = setTimeout(() => {
		newcomers.delete(guildId);
		const channel = after.guild.channels.cache.get(channelId);
		if (!channel?.isSendable()) return;
		toldNewcomers.set(guildId, Date.now());
		channel
			.send({
				content: languageText("voice_listening_newcomer", guildLanguage(after.guild), {
					users: [...members].map((id) => `<@${id}>`).join(", "),
				}),
				allowedMentions: { parse: [] },
			})
			.catch(() => {});
	}, NEWCOMER_BATCH_MS);
	timer.unref?.();
	newcomers.set(guildId, { members, timer });
}

/** Notices go to everyone, so they are in the guild's language. */
function guildLanguage(guild: Guild) {
	const language = parseLocale(guild.preferredLocale);
	return language === Language.Unsupported ? Language.English : language;
}

/**
 * Turn listening on or off for a guild the bot may already be in a call in.
 * The sidecar applies it to the live call at once.
 */
export function applyGuildListening(guild: Guild, listen: boolean) {
	const connection = getNativeConnection(guild.id);
	if (!connection) return;
	sidecar().send({ type: "setListen", guildId: guild.id, listen });
	if (listen) announceListening(guild, connection.channelId, true).catch(() => {});
}
