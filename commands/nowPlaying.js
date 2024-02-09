const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageEmbed } = require('discord.js');
const { getAudioPlayer, songToString } = require('../lib/voice/core');
const { CustomClient } = require('../lib/custom');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('nowplaying')
		.setDescription('Show the song playing'),
	/**
	 * @param {BaseCommandInteraction} interaction 
	 * @param {CustomClient} client 
	**/
	execute(interaction, client) {
		const player = getAudioPlayer(client, interaction, {createPlayer: false});
		if (!player) return interaction.reply({ content: 'Not playing any song' });
		if (!player.nowPlaying) return interaction.reply({ content: "Not playing any song" });		
		interaction.reply({embeds: [new MessageEmbed().setTitle('Now Playing').setDescription(songToString(player.nowPlaying))]});
	},
};
