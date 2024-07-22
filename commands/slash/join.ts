import type { Command } from "../../lib/interaction"

import { SlashCommandBuilder } from 'discord.js'
import { getVoiceConnection } from '@discordjs/voice'
import { joinVoice, getAudioPlayer } from '../../lib/voice/core'
import { dcb } from '../../lib/misc'
import { misc } from '../../lib/misc'

export default {
	data: new SlashCommandBuilder()
		.setName('join')
		.setDescription('Join the voice channel'),
	async execute(interaction, client) {
		if (!interaction.guild || !interaction.inGuild() || !('voice' in interaction.member)) {
			return interaction.reply(misc.errorMessageObj)
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
		if (!connection) return

		dcb.log('Created Player')
		const player = getAudioPlayer(client, interaction, { createPlayer: true })
		if (!player) return
		connection.subscribe(player)

		interaction.reply({
			content: 'Joined voice channel'
		})
	},
} as Command<SlashCommandBuilder>
