import { SlashCommandBuilder } from 'discord.js'
import { getAudioPlayer } from '../../lib/voice/core'

export default {
	data: new SlashCommandBuilder()
		.setName('skip')
		.setDescription('Skip the song'),
	async execute(interaction, client) {
		const player = getAudioPlayer(client, interaction, {createPlayer: false})
		if (!player) return await interaction.reply("I'm not playing anything")
		player.stop()
		interaction.reply({ content: 'Skipped!' })
	}
}
