// @ts-check

const { SlashCommandBuilder } = require('@discordjs/builders');
const { BaseCommandInteraction } = require('discord.js');
const { getAudioPlayer } = require('../lib/voice/core');
const { CustomClient } = require('../lib/custom');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('resume')
		.setDescription('Resume the song'),
	/**
	 * @param {BaseCommandInteraction} interaction 
	 * @param {CustomClient} client 
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
