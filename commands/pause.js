const { SlashCommandBuilder } = require('discord.js')
const { CommandInteraction } = require('discord.js');
const { getAudioPlayer } = require('../lib/voice/core');
const { CustomClient } = require('../lib/custom');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('pause')
		.setDescription('Pause the music playing'),
	/**
	 * @param {CommandInteraction} interaction 
	 * @param {CustomClient} client 
	 */
	async execute(interaction, client) {
		const player = getAudioPlayer(client, interaction, { createPlayer: false });
		if (!player) return await interaction.reply({ content: "Not playing any song" })
		if (player.pause()) {
			await interaction.reply({content: 'Paused!'})
		} else {
			await interaction.reply({ content: 'Failed to pause' })
		}
	}
};
