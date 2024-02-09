const { SlashCommandBuilder } = require('@discordjs/builders');
const { getVoiceConnection } = require('@discordjs/voice');
const { BaseCommandInteraction } = require('discord.js')
const { joinVoice, getAudioPlayer } = require('../lib/voice/core');
const { dcb } = require('../lib/misc');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('join')
		.setDescription('Join the voice channel')
		.addBooleanOption(b => b.setName('player').setDescription('Get the player ready for later playing').setRequired(false)),
	/**
	 * 
	 * @param {BaseCommandInteraction} interaction 
	 * @returns 
	 */
	async execute(interaction, client) {
		if (getVoiceConnection(interaction.guild.id)) {
			return interaction.reply({
				content: 'I am already in a voice channel'
			})
		} else {
			if (!interaction.member.voice.channel) {
				return interaction.reply({
					content: 'You are not in a voice channel'
				})
			}
			dcb.log('Joined voice')
			const connection = joinVoice(interaction.member.voice.channel, interaction);
			if (interaction.options.getBoolean('player', false)) {
				dcb.log('Created Player')
				connection.subscribe(getAudioPlayer(client, interaction, { createPlayer: true }))
			}
			interaction.reply({
				content: 'Joined voice channel'
			})
		}
	},
};
