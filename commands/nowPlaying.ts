import { SlashCommandBuilder } from "discord.js"
import { EmbedBuilder } from "discord.js"
import { getAudioPlayer, songToString } from "../lib/voice/core"
import type { Command } from "../lib/interaction"

export default {
	data: new SlashCommandBuilder()
		.setName("nowplaying")
		.setDescription("Show the song playing"),
	execute(interaction, client) {
		const player = getAudioPlayer(client, interaction, { createPlayer: false })
		if (!player) return interaction.reply({ content: "Not playing any song" })
		if (!player.nowPlaying)
			return interaction.reply({ content: "Not playing any song" })
		interaction.reply({
			embeds: [
				new EmbedBuilder()
					.setTitle("Now Playing")
					.setDescription(songToString(player.nowPlaying)),
			],
		})
	},
} as Command<SlashCommandBuilder>