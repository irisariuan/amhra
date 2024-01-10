const { SlashCommandBuilder } = require('@discordjs/builders');
const { getVoiceConnection } = require('@discordjs/voice');
const { destroyAudioPlayer } = require('../lib/voice');
const { dcb } = require('../lib/misc');

module.exports = {
    data: new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('Disconnect the bot'),
	async execute(interaction, client) {
        const connection = getVoiceConnection(interaction.guildId);
        if (connection) {

            connection.disconnect();
            connection.destroy()
            
            dcb.log('Disconnected')
            interaction.reply({
                content: 'Disconnected'
            })

            //also destroy the audio player if there is one
            destroyAudioPlayer(client, interaction)
        } else {
            interaction.reply({
                content: 'I am not connected to a voice channel'
            })
        }
	}
};
