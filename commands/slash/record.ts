import type { Command } from "../../lib/interaction"
import { SlashCommandBuilder } from 'discord.js'
import { saveRecord, startRecord } from "../../lib/voice/record"

export default {
	data: new SlashCommandBuilder()
		.setName('record')
		.setDescription('Record your conversation'),
	async execute(interaction, client) {
		if (!interaction.guildId) return
		if (!startRecord(interaction)) {
			saveRecord(interaction, 10)
			startRecord(interaction)
			return interaction.reply({content: 'Saving!', ephemeral: true})
		}
		interaction.reply({content: 'Recording started', ephemeral: true})
	},
} as Command<SlashCommandBuilder>
