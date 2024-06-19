import type { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import type { CustomClient } from "./custom";

export interface Command {
    data: SlashCommandBuilder,
    execute: (interaction: ChatInputCommandInteraction, client: CustomClient) => void | Promise<void>
}