import type {
	ChatInputCommandInteraction,
	ContextMenuCommandBuilder,
	GuildMember,
	SlashCommandBuilder,
	UserContextMenuCommandInteraction,
} from "discord.js";
import type { CustomClient } from "./custom";

enum Language {
	English = "en",
	TraditionalChinese = "zh-TW",
}

interface InteractionReactParams<T> {
	interaction: T extends SlashCommandBuilder
		? ChatInputCommandInteraction
		: UserContextMenuCommandInteraction;
	client: CustomClient;
	language: Language;
}

export interface Command<
	T extends SlashCommandBuilder | ContextMenuCommandBuilder,
> {
	data: T;
	execute: (params: InteractionReactParams<T>) => unknown | Promise<unknown>;
}

export function hasVoice(
	interaction: ChatInputCommandInteraction,
): interaction is ChatInputCommandInteraction & { member: GuildMember } {
	return !!(interaction.member && "voice" in interaction.member);
}
