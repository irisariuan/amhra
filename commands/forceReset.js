const { SlashCommandBuilder } = require('discord.js')
const { CommandInteraction } = require('discord.js')
const {destroyAudioPlayer} = require('../lib/voice/core')
const { CustomClient } = require('../lib/custom')

module.exports = {
	data: new SlashCommandBuilder()
		.setName('forcereset')
		.setDescription('Force reset the current player, only use it when you cannot play music properly'),
	/**
	 * @param {CommandInteraction} interaction 
	 * @param {CustomClient} client 
	 */
	async execute(interaction, client) {
        if (destroyAudioPlayer(client, interaction)) {
			return await interaction.reply({content: 'I\'ve reset the player!'})
		}
		await interaction.reply({content: 'Player not found!'})
	},
}