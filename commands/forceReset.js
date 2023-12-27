// @ts-check

const { SlashCommandBuilder } = require('@discordjs/builders');
const { Interaction, Client, BaseCommandInteraction } = require('discord.js');
const {destoryAudioPlayer} = require('../lib/voice')
const { CustomClient } = require('../lib/client');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('forcereset')
		.setDescription('Force reset the current player, only use it when you cannot play music properly'),
	/**
	 * @param {BaseCommandInteraction} interaction 
	 * @param {CustomClient} client 
	 */
	async execute(interaction, client) {
        if (destoryAudioPlayer(client, interaction)) {
			return await interaction.reply({content: 'I\'ve reset the player!'});
		}
		await interaction.reply({content: 'Player not found!'})
	},
};