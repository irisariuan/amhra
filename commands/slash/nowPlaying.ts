import { SlashCommandBuilder } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { getAudioPlayer, songToString } from "../../lib/voice/core";
import type { Command } from "../../lib/interaction";

export default {
	data: new SlashCommandBuilder()
		.setName("nowplaying")
		.setDescription("Show the song playing"),
	async execute(interaction, client) {
		if (!interaction.guildId)
			return await interaction.reply({
				content: "This command can only be used in a server.",
			});

		const player = getAudioPlayer(
			client,
			interaction.guildId,
			interaction.channel,
			{
				createPlayer: false,
			},
		);
		if (!player)
			return interaction.reply({ content: "Not playing any song" });
		if (!player.nowPlaying)
			return interaction.reply({ content: "Not playing any song" });
		const currentPos = player.getCurrentSongPosition();
		interaction.reply({
			embeds: [
				new EmbedBuilder()
					.setTitle("Now Playing")
					.setDescription(
						songToString(
							player.nowPlaying,
							undefined,
							currentPos === null
								? undefined
								: Math.round(currentPos / 1000),
						),
					),
			],
		});
	},
} as Command<SlashCommandBuilder>;
