import { SlashCommandBuilder } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { getAudioPlayer, songToString } from "../../lib/voice/core";
import type { Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";

export default {
	data: new SlashCommandBuilder()
		.setName("nowplaying")
		.setDescription("Show the song playing"),
	async execute({ interaction, client, language }) {
		if (!interaction.guildId)
			return await interaction.reply({
				content: languageText("server_only_command", language),
			});

		const player = getAudioPlayer(
			client,
			interaction.guildId,
			interaction.channel,
			language,
			{
				createPlayer: false,
			},
		);
		if (!player)
			return interaction.reply({
				content: languageText("not_playing", language),
			});
		if (!player.nowPlaying)
			return interaction.reply({
				content: languageText("not_playing", language),
			});
		const currentPos = player.getCurrentSongPosition();
		interaction.reply({
			embeds: [
				new EmbedBuilder()
					.setTitle(languageText("now_playing", language))
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
