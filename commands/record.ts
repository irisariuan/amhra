import type { Command } from "../lib/interaction";
import { SlashCommandBuilder } from 'discord.js'

export default {
	data: new SlashCommandBuilder()
		.setName('record')
		.setDescription('Record your conversation'),
	async execute(interaction, client) {
		// await record(interaction);
		interaction.reply({content: 'We\'re still working on this function!'});
	},
} as Command
