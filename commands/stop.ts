import { SlashCommandBuilder } from 'discord.js'
import { getAudioPlayer } from '../lib/voice/core'
import type { Command } from '../lib/interaction'

export default {
    data: new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop the music playing'),
    async execute(interaction, client) {
        const player = getAudioPlayer(client, interaction)
        if (player?.cleanStop()) {
            return interaction.reply({
                content: 'Stopped the music'
            })
        }
        interaction.reply({
            content: 'Not playing music'
        })
    }
} as Command<SlashCommandBuilder>