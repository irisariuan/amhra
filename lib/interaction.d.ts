import type { ChatInputCommandInteraction, ContextMenuCommandBuilder, SlashCommandBuilder } from "discord.js";
import type { CustomClient } from "./custom";

export interface Command<T extends SlashCommandBuilder | ContextMenuCommandBuilder> {
    data: T,
    execute: (interaction: ChatInputCommandInteraction, client: CustomClient) => void | Promise<void>
}