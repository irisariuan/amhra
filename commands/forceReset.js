// @ts-check

const { SlashCommandBuilder } = require('@discordjs/builders');
const { Interaction, Client, BaseCommandInteraction } = require('discord.js');
const {} = require('../lib/voice')

module.exports = {
	data: new SlashCommandBuilder()
		.setName('forcereset')
		.setDescription('Force reset current player, only use when you cannot play music properly'),
	/**
	 * @param {BaseCommandInteraction} interaction 
	 * @param {Client} client 
	 */
	async execute(interaction, client) {
        if (!client.player.get(interaction.guild.id)) return await interaction.reply({content: 'Player not found!'})
        delete client.player[interaction.guild.id]
		await interaction.reply({content: 'I\'ve reset the player!'});
	},
};