import { SlashCommandBuilder } from 'discord.js'
import { getAudioPlayer, getConnection } from "../lib/voice/core"
import type { Command } from '../lib/interaction'

export default {
	data: new SlashCommandBuilder()
		.setName("volume")
		.setDescription("Set volume of the bot")
		.addIntegerOption(opt =>
			opt
				.setName("volume")
				.setDescription("Set the volume of the bot")
				.setMinValue(0)
				.setMaxValue(200)
				.setRequired(true)
		),
	execute(interaction, client) {
		const volume = interaction.options.getInteger("volume", true) / 100
		const player = getAudioPlayer(client, interaction, { createPlayer: false })
		if (!getConnection(interaction.guildId))
			return interaction.reply({ content: "I'm not in a voice channel!" })
		if (!player) return interaction.reply({ content: "I'm not playing song!" })
		player.setVolume(volume)
		interaction.reply({ content: `Set the volume to ${volume * 100}%` })
	},
} as Command<SlashCommandBuilder>