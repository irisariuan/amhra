import { SlashCommandBuilder } from "discord.js";
import { getAudioPlayer, timeFormat } from "../../lib/voice/core";
import type { Command } from "../../lib/interaction";

export default {
	data: new SlashCommandBuilder()
		.setName("skipnonmusic")
		.setDescription("Skip current non-music part"),
	async execute(interaction, client) {
		const player = getAudioPlayer(client, interaction, {
			createPlayer: false,
		});
		if (!player) return await interaction.reply("I'm not playing anything");
		const currentSegment = player.currentSegment();
		if (!currentSegment) {
			return await interaction.reply({
				content: "I'm not playing any non-music part",
			});
		}
		if (await player.skipCurrentSegment()) {
			await interaction.reply({
				content: `Skipped to \`${timeFormat(currentSegment.segment[1])}\``,
			});
		} else {
			await interaction.reply({
				content: "Failed to skip the current non-music part",
			});
		}
	},
} as Command<SlashCommandBuilder>;
