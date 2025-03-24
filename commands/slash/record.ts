import type { Command } from "../../lib/interaction"
import { MessageFlags, SlashCommandBuilder } from 'discord.js'
import { saveRecord, startRecord } from "../../lib/voice/record"

export default {
	data: new SlashCommandBuilder()
		.setName('record')
		.setDescription('Record your conversation'),
	async execute(interaction, client) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral })
		if (!interaction.guildId) return
		if (!await startRecord(interaction)) {
			await saveRecord(interaction, 10)
			await startRecord(interaction)
			return interaction.editReply({ content: 'Saving!' })
		}
		interaction.editReply({ content: 'Recording started' })
	},
} as Command<SlashCommandBuilder>
