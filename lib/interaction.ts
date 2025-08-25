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

export function parseLocale(locale: Locale): Language {
	if (locale.startsWith("en")) return Language.English;
	if (locale === Locale.ChineseTW) return Language.TraditionalChinese;
	if (locale === Locale.Japanese) return Language.Japanese;
	return Language.Unsupported;
}
