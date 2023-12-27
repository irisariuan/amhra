// @ts-check

const { SlashCommandBuilder } = require('@discordjs/builders');
const { Interaction, Client, BaseCommandInteraction } = require('discord.js');
const { getAudioPlayer } = require('../lib/voice');
const { CustomClient } = require('../lib/client');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('pause')
		.setDescription('Pause the music playing'),
	/**
	 * @param {BaseCommandInteraction} interaction 
	 * @param {CustomClient} client 
	 */
	async execute(interaction, client) {
		const player = getAudioPlayer(client, interaction, { createPlayer: false });
		if (!player) return await interaction.reply({ content: "I'm not playing any song" })
		if (player.pause()) {
			await interaction.reply({content: 'Paused!'})
		} else {
			await interaction.reply({ content: 'Failed to pause' })
		}
	}
};
