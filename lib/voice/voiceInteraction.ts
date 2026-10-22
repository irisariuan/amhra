import type {
	ChatInputCommandInteraction,
	GuildMember,
	Message,
	MessageCreateOptions,
	MessageEditOptions,
	SendableChannels,
} from "discord.js";
import { languageCommandName, languageText } from "../language";
import type { VoiceIntent } from "./intent";

/** What a reply to an interaction may carry that a plain message may not. */
type ReplyPayload = string | (MessageCreateOptions & {
	ephemeral?: boolean;
	withResponse?: boolean;
	flags?: unknown;
});

/**
 * Enough of a slash command interaction for the command handlers, answering
 * in `channel`. Each answer carries a line saying who asked, by voice, for
 * what, since there is no "used /skip" header as there is for a typed one.
 *
 * Ephemeral follow-ups, such as the search picker, have nobody to be shown to
 * privately and are refused; the handlers already treat that as "skip it".
 */
export function voiceInteraction(
	member: GuildMember,
	channel: SendableChannels,
	intent: VoiceIntent,
): ChatInputCommandInteraction {
	const name = languageCommandName(intent.command, intent.language)?.name ?? intent.command;
	const heading = languageText("voice_heard", intent.language, {
		user: `<@${member.id}>`,
		command: intent.command === "play" ? `/${name} ${intent.query}` : `/${name}`,
	});
	let reply: Message | null = null;

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
		reply = await channel.send(options(payload, true));
		return reply;
	};

	const values: Record<string, string | boolean | number | undefined> = {
		search: intent.command === "play" ? intent.query : undefined,
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
	return interaction as unknown as ChatInputCommandInteraction;
}
