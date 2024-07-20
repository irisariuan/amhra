import { SlashCommandBuilder } from 'discord.js'
import { getAudioPlayer } from '../lib/voice/core'
import type { Command } from '../lib/interaction'

export default {
	data: new SlashCommandBuilder()
		.setName('remove')
		.setDescription('Remove a song from queue')
		.addIntegerOption(opt => opt.setName('index').setDescription('Index of the item you would like to remove').setMinValue(1).setRequired(true)),
	async execute(interaction, client) {
		const player = getAudioPlayer(client, interaction, { createPlayer: false })
		const index = interaction.options.getInteger('index', true)
		if (!player) {
			await interaction.reply({ content: 'The queue is clean!' })
			return
		}
		if (index > player.queue.length) return await interaction.reply({ content: 'Out of index!' })
		const removed = player.queue.splice(index - 1, 1)[0]
		const videoDetail = client.cache.getUrl(removed)?.value
		if (videoDetail) return interaction.reply({ content: `Removed ${videoDetail.title} (\`${removed}\`)` })
		return interaction.reply({ content: `Removed \`${removed}\`!` })
	},
} as Command<SlashCommandBuilder>