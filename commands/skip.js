const { SlashCommandBuilder } = require('discord.js')
const { CommandInteraction } = require('discord.js');
const { getAudioPlayer } = require('../lib/voice/core');
const { CustomClient } = require('../lib/custom');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('skip')
		.setDescription('Skip the song'),
	/**
	 * @param {CommandInteraction} interaction 
	 * @param {CustomClient} client 
	 */
	async execute(interaction, client) {
		const player = getAudioPlayer(client, interaction, {createPlayer: false});
		if (!player) return await interaction.reply("I'm not playing anything");
		player.stop();
		interaction.reply({ content: 'Skipped!' });
	}
};
