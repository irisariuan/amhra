const { SlashCommandBuilder } = require('@discordjs/builders');
const { getVoiceConnection } = require('@discordjs/voice');
const { joinVoice } = require('../lib/voice');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('join')
		.setDescription('Join the voice channel'),
	async execute(interaction) {
        if (!await getVoiceConnection(interaction.guild.id)) {
			if (!interaction.member.voice.channel) {
				return interaction.reply({
					content: 'You are not in a voice channel'
				})
			}
			joinVoice(interaction.member.voice.channel, interaction);
			interaction.reply({
				content: 'Joined voice channel'
			})
		} else {
			return interaction.reply({
				content: 'I am already in a voice channel'
			})
		}
	},
};
