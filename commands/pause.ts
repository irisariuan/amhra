import type { Command } from "../lib/interaction"
import { SlashCommandBuilder } from 'discord.js'
import { getAudioPlayer } from '../lib/voice/core'
import { dcb } from '../lib/misc'

export default {
	data: new SlashCommandBuilder()
		.setName('pause')
		.setDescription('Pause the music playing'),
	async execute(interaction, client) {
		const player = getAudioPlayer(client, interaction, { createPlayer: false })
		if (!player) return await interaction.reply({ content: "Not playing any song" })
		if (player.pause()) {
			dcb.log(`(Guild ID: ${player.guildId}) Paused the music`)
			await interaction.reply({content: 'Paused!'})
		} else {
			await interaction.reply({ content: 'Failed to pause' })
		}
	}
} as Command