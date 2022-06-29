const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageEmbed } = require('discord.js');
const { getAudioPlayer, songToStr } = require('../lib/voice');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('nowplaying')
		.setDescription('Show the song playing'),
	/**
	 * @param {BaseCommandInteraction} interaction 
	 * @param {Client} client 
	**/
	async execute(interaction, client) {
		const player = getAudioPlayer(client, interaction, {createPlayer: false});
		if (!player) return await interaction.reply({ content: 'I am not playing any song' });
		if (!player.nowPlaying) return await interaction.reply({ content: "I'm not playing anything" });		
		interaction.reply({embeds: [new MessageEmbed().setTitle('Now Playing').setDescription(songToStr(player.nowPlaying))]});
	},
};
