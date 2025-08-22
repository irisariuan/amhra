import type { ChatInputCommandInteraction, ContextMenuCommandBuilder, SlashCommandBuilder, UserContextMenuCommandInteraction } from "discord.js";
import type { CustomClient } from "./custom";

export interface Command<T extends SlashCommandBuilder | ContextMenuCommandBuilder> {
    data: T,
    execute: (interaction: T extends SlashCommandBuilder ? ChatInputCommandInteraction : UserContextMenuCommandInteraction, client: CustomClient) => unknown | Promise<unknown>
}