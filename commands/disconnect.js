const { SlashCommandBuilder, CommandInteraction } = require('discord.js')
const { getVoiceConnection } = require('@discordjs/voice');
const { destroyAudioPlayer, getConnection } = require('../lib/voice/core');
const { dcb } = require('../lib/misc');
const { CustomClient } = require('../lib/custom');

module.exports = {
    data: new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('Disconnect the bot'),
    /**
     * 
     * @param {CommandInteraction} interaction 
     * @param {CustomClient} client 
     */
	execute(interaction, client) {
        const connection = getConnection(interaction);
        if (connection) {

            connection.disconnect();
            connection.destroy()
            
            dcb.log('Disconnected')
            interaction.reply({
                content: 'Disconnected'
            })

            //also destroy the audio player if there is one
            destroyAudioPlayer(client, interaction.guildId)
        } else {
            interaction.reply({
                content: 'I am not connected to a voice channel'
            })
        }
	}
};
