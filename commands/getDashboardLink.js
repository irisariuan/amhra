const { SlashCommandBuilder, CommandInteraction } = require('discord.js')
const { getAudioPlayer, getConnection } = require("../lib/voice/core")
const { CustomClient } = require("../lib/custom")
const { createLink } = require('../lib/dashboard')

module.exports = {
	data: new SlashCommandBuilder()
		.setName("dashboard")
		.setDescription("Get the one-time website for controlling the bot"),
	/**
	 * @param {CommandInteraction} interaction
	 * @param {CustomClient} client
	 */
	async execute(interaction, client) {
        const token = client.createToken(interaction.guildId)
        if (!token) {
            return interaction.reply({content: 'An error occurred while processing this command', ephemeral: true})
        }
        interaction.reply(`Link to the dashboard: ${await createLink(interaction.guildId, token)}`)
	},
}
