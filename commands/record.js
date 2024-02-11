const { SlashCommandBuilder } = require('discord.js')
const { VoiceReceiver } = require('@discordjs/voice');
const { record } = require('../lib/voice/core');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('record')
		.setDescription('Record your conversation'),
	async execute(interaction, client) {
		// await record(interaction);
		interaction.reply({content: 'We\'re still working on this function!'});
	},
};
