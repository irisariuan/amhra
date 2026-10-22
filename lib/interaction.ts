import {
	AutocompleteInteraction,
	ChatInputCommandInteraction,
	ContextMenuCommandBuilder,
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
	/** Suggests values for options built with `.setAutocomplete(true)`. */
	autocomplete?: (params: AutocompleteParams) => unknown | Promise<unknown>;
}

interface AutocompleteParams {
	interaction: AutocompleteInteraction;
	client: CustomClient;
	language: Language;
}