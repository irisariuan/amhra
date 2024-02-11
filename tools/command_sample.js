const { SlashCommandBuilder } = require('discord.js')
const { Interaction, Client, CommandInteraction } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('test')
		.setDescription('Testing'),
	/**
	 * @param {CommandInteraction} interaction 
	 * @param {Client} client 
	 */
	async execute(interaction, client) {
		interaction.reply({content: 'test'});
	},
};
