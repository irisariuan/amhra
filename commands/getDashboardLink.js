const { SlashCommandBuilder, CommandInteraction, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js')
const { getAudioPlayer, getConnection } = require("../lib/voice/core")
const { CustomClient } = require("../lib/custom")
const { createLink } = require('../lib/dashboard')

module.exports = {
	data: new SlashCommandBuilder()
		.setName("dashboard")
		.setDescription("Online dashboard for controlling song activities"),
	/**
	 * @param {CommandInteraction} interaction
	 * @param {CustomClient} client
	 */
	async execute(interaction, client) {
		const token = client.createToken(interaction.guildId)
		if (!token) {
			return interaction.reply({ content: 'An error occurred while processing this command', ephemeral: true })
		}

		const link = await createLink(interaction.guildId, token)
		const linkButton = new ButtonBuilder()
			.setLabel('Dashboard')
			.setURL(link)
			.setStyle(ButtonStyle.Link)
		const row = new ActionRowBuilder()
			.addComponents(linkButton)

		interaction.reply({ components: [row], ephemeral: true })
	},
}
