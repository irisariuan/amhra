import type { Command } from "../../lib/interaction";

import { SlashCommandBuilder } from "discord.js";
import { calculateHash } from "../../lib/core";
import { languageText } from "../../lib/language";

export default {
	data: new SlashCommandBuilder()
		.setName("version")
		.setDescription("Show the current version of the bot"),
	async execute({ interaction, language }) {
		interaction.reply(
			languageText("current_version", language, {
				version: `R${await calculateHash("dist/**/*.*")}C${await calculateHash()}`,
			}),
		);
	},
} as Command<SlashCommandBuilder>;
