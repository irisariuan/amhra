import type { Command } from "../lib/interaction"
import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import { createLink } from '../lib/dashboard'

export default {
	data: new SlashCommandBuilder()
		.setName("dashboard")
		.setDescription("Online dashboard for controlling song activities"),
	async execute(interaction, client) {
		if (!interaction.guildId) return
		const token = client.createToken(interaction.guildId)
		if (!token) {
			return interaction.reply({ content: 'An error occurred while processing this command', ephemeral: true })
		}

		const link = await createLink(interaction.guildId, token)
		const linkButton = new ButtonBuilder()
			.setLabel('Dashboard')
			.setURL(link)
			.setStyle(ButtonStyle.Link)
		const row = new ActionRowBuilder<ButtonBuilder>()
			.addComponents(linkButton)
		interaction.reply({ components: [row], ephemeral: true })
	},
} as Command
