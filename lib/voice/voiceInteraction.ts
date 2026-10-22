import {
	type ChatInputCommandInteraction,
	escapeMarkdown,
	type GuildMember,
	type Message,
	type MessageCreateOptions,
	type MessageEditOptions,
	type SendableChannels,
} from "discord.js";
import { languageCommandName, languageText } from "../language";
import type { VoiceIntent } from "./intent";

/** What a reply to an interaction may carry that a plain message may not. */
type ReplyPayload = string | (MessageCreateOptions & {
	ephemeral?: boolean;
	withResponse?: boolean;
	flags?: unknown;
});

/** What a play command found for what was asked. */
export interface Found {
	/** The video's or playlist's title. */
	title: string;
	/** Added behind what is playing rather than started. */
	queued: boolean;
	/** Added to play straight after what is playing. */
	next: boolean;
}

const finders = new WeakMap<object, (found: Found) => void>();

/**
 * Tell a voice command what the search it asked for found, so it can be said
 * aloud. Nothing, for a typed command.
 */
export function reportFound(interaction: object, found: Found) {
	finders.get(interaction)?.(found);
}

/**
 * Enough of a slash command interaction for the command handlers, answering
 * in `channel`. Each answer carries a line saying who asked, by voice, for
 * what, since there is no "used /skip" header as there is for a typed one.
 *
 * Ephemeral follow-ups, such as the search picker, have nobody to be shown to
 * privately and are refused; the handlers already treat that as "skip it".
 *
 * For someone who asked to see what was heard, `transcript` puts their words
 * in the heading, and `message` — the "listening…" posted when they said the
 * name — becomes the answer instead of a second message. `onFound` hears
 * what a search found (`reportFound`).
 */
export function voiceInteraction(
	member: GuildMember,
	channel: SendableChannels,
	intent: VoiceIntent,
	{
		message,
		transcript,
		onFound,
	}: { message?: Message | null; transcript?: string; onFound?: (found: Found) => void } = {},
): ChatInputCommandInteraction {
	const name = languageCommandName(intent.command, intent.language)?.name ?? intent.command;
	const given = Object.entries(intent.options ?? {})
		.filter(([option]) => !(intent.command === "play" && option === "search"))
		.map(([option, value]) => ` ${option}:${value}`)
		.join("");
	const subcommand = intent.command === "play" ? undefined : intent.subcommand;
	const command =
		intent.command === "play"
			? `/${name} ${intent.query}${given}`
			: `/${name}${subcommand ? ` ${subcommand}` : ""}${given}`;
	const heading = transcript
		? languageText("voice_heard_transcript", intent.language, {
				user: `<@${member.id}>`,
				text: escapeMarkdown(transcript),
				command,
			})
		: languageText("voice_heard", intent.language, { user: `<@${member.id}>`, command });
	let reply: Message | null = null;
	/** Posted before the command ran, and not yet used for its answer. */
	let waiting = message ?? null;

	const options = (payload: ReplyPayload, withHeading: boolean) => {
		const { ephemeral: _e, withResponse: _w, flags: _f, ...rest } =
			typeof payload === "string" ? { content: payload } : payload;
		return {
			...rest,
			content: withHeading ? `${heading}\n${rest.content ?? ""}` : rest.content,
			// Shown, not pinged.
			allowedMentions: { parse: [] },
		} as MessageCreateOptions;
	};
	const send = async (payload: ReplyPayload) => {
		if (waiting) {
			const existing = waiting;
			waiting = null;
			reply = await existing.edit(options(payload, true) as MessageEditOptions);
		} else {
			reply = await channel.send(options(payload, true));
		}
		return reply;
	};

	const values: Record<string, string | boolean | number | undefined> = {
		...intent.options,
		search: intent.command === "play" ? intent.query : intent.options?.search,
	};
	const option = (name: string) => values[name] ?? null;

	const interaction = {
		commandName: intent.command,
		guild: member.guild,
		guildId: member.guild.id,
		member,
		user: member.user,
		channel,
		channelId: channel.id,
		locale: member.guild.preferredLocale,
		options: {
			getString: option,
			getBoolean: option,
			getInteger: option,
			getNumber: option,
			getSubcommand: () => subcommand ?? null,
		},
		get replied() {
			return reply !== null;
		},
		get deferred() {
			return reply !== null;
		},
		reply: send,
		// There is no "thinking…" for a message, so the heading stands in for
		// it until the answer replaces it.
		deferReply: async () => {
			const message = await send({ content: "…" });
			return { resource: { message } };
		},
		editReply: async (payload: ReplyPayload) =>
			reply ? reply.edit(options(payload, true) as MessageEditOptions) : send(payload),
		followUp: async (payload: ReplyPayload) => {
			if (typeof payload !== "string" && payload.ephemeral) {
				throw new Error("No ephemeral messages for a voice command");
			}
			return channel.send(options(payload, false));
		},
		deleteReply: async () => {
			await reply?.delete();
			reply = null;
		},
	};
	if (onFound) finders.set(interaction, onFound);
	return interaction as unknown as ChatInputCommandInteraction;
}
