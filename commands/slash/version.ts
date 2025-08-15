import type { Command } from "../../lib/interaction";

import { SlashCommandBuilder } from "discord.js";
import { calculateHash } from "../../lib/core";

export default {
	data: new SlashCommandBuilder()
		.setName("version")
		.setDescription("Show the current version of the bot"),
	async execute(interaction, client) {
		interaction.reply(
			`Current version is **R${await calculateHash("dist/**/*.*")}C${await calculateHash()}**`,
		);
	},
} as Command<SlashCommandBuilder>;
