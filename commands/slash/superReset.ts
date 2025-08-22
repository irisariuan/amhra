import type { Command } from "../../lib/interaction";

import { SlashCommandBuilder } from "discord.js";

export default {
	data: new SlashCommandBuilder()
		.setName("superreset")
		.setDescription("Reset all the players"),
	execute({ interaction, client }) {
		client.clearPlayers();
		interaction.reply({ content: "Super reset!" });
	},
} as Command<SlashCommandBuilder>;
