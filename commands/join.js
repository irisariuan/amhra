const { SlashCommandBuilder } = require('discord.js')
const { getVoiceConnection } = require('@discordjs/voice')
const { CommandInteraction } = require('discord.js')
const { joinVoice, getAudioPlayer } = require('../lib/voice/core')
const { dcb } = require('../lib/misc')
const misc = require('../lib/misc')

module.exports = {
	data: new SlashCommandBuilder()
		.setName('join')
		.setDescription('Join the voice channel')
		.addBooleanOption(b => b.setName('player').setDescription('Get the player ready for later playing').setRequired(false)),
	/**
	 * 
	 * @param {CommandInteraction} interaction 
	 * @returns 
	 */
	async execute(interaction, client) {
		if (!interaction.guild || !interaction.inGuild() || !('voice' in interaction.member)) {
			return interaction.reply(misc.misc.errorMessageObj)
		}

		if (getVoiceConnection(interaction.guild.id)) {
			return interaction.reply({
				content: 'I am already in a voice channel'
			})
		}

		if (!interaction.member.voice.channel) {
			return interaction.reply({
				content: 'You are not in a voice channel'
			})
		}
		dcb.log('Joined voice')
		const connection = joinVoice(interaction.member.voice.channel, interaction)

		if (interaction.options.getBoolean('player', false)) {
			dcb.log('Created Player')
			const player = getAudioPlayer(client, interaction, { createPlayer: true })
			if (!player) return
			connection.subscribe(player)
		}
		interaction.reply({
			content: 'Joined voice channel'
		})
	},
}
