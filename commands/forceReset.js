// @ts-check

const { SlashCommandBuilder } = require('@discordjs/builders');
const { Interaction, Client, BaseCommandInteraction } = require('discord.js');
const {destoryAudioPlayer} = require('../lib/voice')

module.exports = {
	data: new SlashCommandBuilder()
		.setName('forcereset')
		.setDescription('Force reset current player, only use when you cannot play music properly'),
	/**
	 * @param {BaseCommandInteraction} interaction 
	 * @param {Client} client 
	 */
	async execute(interaction, client) {
        if (destoryAudioPlayer(client, interaction)) {
			return await interaction.reply({content: 'I\'ve reset the player!'});
		}
		await interaction.reply({content: 'Player not found!'})
	},
};