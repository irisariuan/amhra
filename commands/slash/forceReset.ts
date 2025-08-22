import { SlashCommandBuilder } from "discord.js";
import { destroyAudioPlayer } from "../../lib/voice/core";
import type { Command } from "../../lib/interaction";

export default {
	data: new SlashCommandBuilder()
		.setName("forcereset")
		.setDescription(
			"Force reset the current player, only use it when you cannot play music properly",
		),
	async execute({ interaction, client }) {
		if (!interaction.guildId) return;
		if (destroyAudioPlayer(client, interaction.guildId)) {
			return await interaction.reply({
				content: "I've reset the player!",
			});
		}
		await interaction.reply({ content: "Player not found!" });
	},
} as Command<SlashCommandBuilder>;
