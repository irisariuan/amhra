// @ts-check

const { SlashCommandBuilder } = require('@discordjs/builders');
const { Interaction, Client, BaseCommandInteraction } = require('discord.js');
const { CustomClient } = require('../lib/custom');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('superreset')
		.setDescription('Reset all the players'),
	/**
	 * @typedef {Array<string>} 
	 * @param {BaseCommandInteraction} interaction 
	 * @param {CustomClient} client 
	 */
	async execute(interaction, client) {
        client.player.clear()
		interaction.reply({content: 'Super reset!'});
	},
};
