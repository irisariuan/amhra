// @ts-check

const { SlashCommandBuilder } = require('@discordjs/builders');
const { Interaction, Client, BaseCommandInteraction } = require('discord.js');
const { getAudioPlayer } = require('../lib/voice');
const { CustomClient } = require('../lib/custom');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('remove')
		.setDescription('Remove a song from queue')
		.addIntegerOption(opt => opt.setName('index').setDescription('Index of the item you would like to remove').setMinValue(1).setRequired(true)),
	/**
	 * @param {BaseCommandInteraction} interaction 
	 * @param {CustomClient} client 
	 */
	async execute(interaction, client) {
		const player = getAudioPlayer(client, interaction, {createPlayer: false});
		const index = interaction.options.getInteger('index');
		if (!player) return await interaction.reply({ content: 'The queue is clear!' });
		if (index > player.queue.length) return await interaction.reply({ content: 'Out of index!' });
		removed = player.queue.splice(index-1, 1)[0];
		return await interaction.reply({ content: `Removed \`${removed}\`!` })
	},
};
