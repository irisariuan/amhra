import type { Command } from "../../lib/interaction";

import { SlashCommandBuilder } from "discord.js";
import { languageText } from "../../lib/language";

export default {
	data: new SlashCommandBuilder()
		.setName("superreset")
		.setDescription("Reset all the players"),
	execute({ interaction, client, language }) {
		client.clearPlayers();
		interaction.reply({ content: languageText("super_reset", language) });
	},
} as Command<SlashCommandBuilder>;
