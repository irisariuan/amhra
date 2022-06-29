// @ts-check

const { SlashCommandBuilder } = require('@discordjs/builders');
const { Interaction, Client, BaseCommandInteraction } = require('discord.js');
const { getAudioPlayer } = require('../lib/voice');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('resume')
		.setDescription('Resume the song'),
	/**
	 * @param {BaseCommandInteraction} interaction 
	 * @param {Client} client 
	 */
	async execute(interaction, client) {
		const player = getAudioPlayer(client, interaction, {createPlayer : false})
		if (!player) return await interaction.reply({ content: 'I am not playing any song' })
		if (player.unpause()) {
			await interaction.reply({content: 'Resumed!'});
		} else {
			await interaction.reply({content: 'Fail to resume the song!'})
		}
	},
};
