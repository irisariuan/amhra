const { SlashCommandBuilder } = require('@discordjs/builders');
const { getAudioPlayer } = require('../lib/voice/core');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop the music playing'),
    async execute(interaction, client) {
        const player = getAudioPlayer(client, interaction);
        if (player.cleanStop()) {
            return interaction.reply({
                content: 'Stopped the music'
            })
        }
        interaction.reply({
            content: 'Not playing music'
        })
    }
};
