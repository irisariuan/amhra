import { SlashCommandBuilder } from "discord.js";
import { destroyAudioPlayer } from "../../lib/voice/core";
import type { Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";

export default {
	data: new SlashCommandBuilder()
		.setName("forcereset")
		.setDescription(
			"Force reset the current player, only use it when you cannot play music properly",
		),
	async execute({ interaction, client, language }) {
		if (!interaction.guildId) return;
		if (destroyAudioPlayer(client, interaction.guildId)) {
			return await interaction.reply({
				content: languageText("reset_player", language),
			});
		}
		await interaction.reply({
			content: languageText("player_not_found", language),
		});
	},
} as Command<SlashCommandBuilder>;
