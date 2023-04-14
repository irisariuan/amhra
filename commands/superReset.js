// @ts-check

const { SlashCommandBuilder } = require('@discordjs/builders');
const { Interaction, Client, BaseCommandInteraction } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('superreset')
		.setDescription('Reset all the players'),
	/**
	 * @param {BaseCommandInteraction} interaction 
	 * @param {Client} client 
	 */
	async execute(interaction, client) {
        client.player.clear()
		interaction.reply({content: 'Super reset!'});
	},
};
