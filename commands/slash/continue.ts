import { SlashCommandBuilder } from 'discord.js'
import { getAudioPlayer } from '../../lib/voice/core'
import type { Command } from '../../lib/interaction'

export default {
	data: new SlashCommandBuilder()
		.setName('resume')
		.setDescription('Resume the song'),
	async execute(interaction, client) {
		const player = getAudioPlayer(client, interaction, { createPlayer: false })

		if (!player) return await interaction.reply({ content: 'I am not playing any song' })
		if (player.unpause()) {
			await interaction.reply({ content: 'Resumed!' })
		} else {
			await interaction.reply({ content: 'Fail to resume the song!' })
		}
	},
} as Command<SlashCommandBuilder>
