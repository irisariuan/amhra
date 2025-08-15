import type { Command } from "../../lib/interaction";

import { SlashCommandBuilder } from "discord.js";
import { calculateHash } from "../../lib/core";

export default {
	data: new SlashCommandBuilder()
		.setName("superreset")
		.setDescription("Reset all the players"),
	execute(interaction, client) {
		interaction.reply(`Current version is **${calculateHash()}**`);
	},
} as Command<SlashCommandBuilder>;
