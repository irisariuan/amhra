import {
	ChatInputCommandInteraction,
	ContextMenuCommandBuilder,
	GuildMember,
	Locale,
	SlashCommandBuilder,
	UserContextMenuCommandInteraction,
} from "discord.js";
import type { CustomClient } from "./custom";

export enum Language {
	English = "en",
	TraditionalChinese = "zhTw",
	Japanese = "ja",
	Korean = "ko",
	Unsupported = "unsupported",
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