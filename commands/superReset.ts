import type { Command } from "../lib/interaction"

import { SlashCommandBuilder } from 'discord.js'
import { Interaction, Client, CommandInteraction } from 'discord.js'
import { CustomClient } from '../lib/custom'

export default {
	data: new SlashCommandBuilder()
		.setName('superreset')
		.setDescription('Reset all the players'),
	execute(interaction, client) {
		client.player.clear()
		interaction.reply({ content: 'Super reset!' })
	},
} as Command<SlashCommandBuilder>
