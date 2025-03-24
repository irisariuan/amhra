import type { Command } from "../../lib/interaction"
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContextMenuCommandBuilder, ApplicationCommandType } from 'discord.js'
import { createLink } from '../../lib/dashboard'

export default {
	data: new ContextMenuCommandBuilder()
		.setName("dashboard")
		.setType(ApplicationCommandType.User),
	async execute(interaction, client) {
		if (!interaction.guildId) return
		const token = client.createToken([interaction.guildId])
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
} as Command<ContextMenuCommandBuilder>
