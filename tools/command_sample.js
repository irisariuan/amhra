const { SlashCommandBuilder } = require('@discordjs/builders');
const { Interaction, Client, BaseCommandInteraction } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('test')
		.setDescription('Testing'),
	/**
	 * @param {BaseCommandInteraction} interaction 
	 * @param {Client} client 
	 */
	async execute(interaction, client) {
		interaction.reply({content: 'test'});
	},
};
