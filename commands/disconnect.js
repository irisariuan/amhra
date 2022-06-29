const { SlashCommandBuilder } = require('@discordjs/builders');
const { getVoiceConnection } = require('@discordjs/voice');
const { getAudioPlayer } = require('../lib/voice');

module.exports = {
    data: new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('Disconnect the bot'),
	async execute(interaction, client) {
        const connection = getVoiceConnection(interaction.guildId);
        if (connection) {
            connection.disconnect();

            interaction.reply({
                content: 'Disconnected'
            })

            //also destory the audio player if there is one
            const player = getAudioPlayer(client, interaction);
            if (player.stop()) {
                //clear the queue and reset the player
                player.queue = [];
                player.isPlaying = false;
            }
        } else {
            interaction.reply({
                content: 'I am not connected to a voice channel'
            })
        }
	}
};
