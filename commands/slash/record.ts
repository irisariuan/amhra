import type { Command } from "../../lib/interaction"
import { SlashCommandBuilder } from 'discord.js'
import { saveRecord, startRecord } from "../../lib/voice/record"

const record: string[] = []

export default {
	data: new SlashCommandBuilder()
		.setName('record')
		.setDescription('Record your conversation'),
	async execute(interaction, client) {
		if (!interaction.guildId) return
		if (record.includes(interaction.guildId)) {
			await saveRecord(interaction, 20)
			return interaction.reply({ content: 'Saving!', ephemeral: true })
		}
		await startRecord(interaction)
		record.push(interaction.guildId)

		interaction.reply({content: 'Recording started', ephemeral: true})
	},
} as Command<SlashCommandBuilder>
