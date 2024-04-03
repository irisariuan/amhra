const { SlashCommandBuilder } = require('discord.js')
const { Interaction, Client, CommandInteraction } = require('discord.js')
const { CustomClient } = require('../lib/custom')

module.exports = {
	data: new SlashCommandBuilder()
		.setName('superreset')
		.setDescription('Reset all the players'),
	/**
	 * @typedef {Array<string>} 
	 * @param {CommandInteraction} interaction 
	 * @param {CustomClient} client 
	 */
	execute(interaction, client) {
        client.player.clear()
		interaction.reply({content: 'Super reset!'})
	},
}
