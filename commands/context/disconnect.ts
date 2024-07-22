import { ContextMenuCommandBuilder, ApplicationCommandType } from 'discord.js'
import { destroyAudioPlayer, getConnection } from '../../lib/voice/core'
import { dcb } from '../../lib/misc'
import type { Command } from '../../lib/interaction'

export default {
    data: new ContextMenuCommandBuilder()
    .setName('disconnect')
    .setType(ApplicationCommandType.User),
	execute(interaction, client) {
        const connection = getConnection(interaction.guildId)
        if (connection) {
            connection.disconnect()
            connection.destroy()
            
            dcb.log('Disconnected')
            interaction.reply({
                content: 'Disconnected'
            })
            if (!interaction.guildId) return
            //also destroy the audio player if there is one
            destroyAudioPlayer(client, interaction.guildId)
        } else {
            interaction.reply({
                content: 'I am not connected to a voice channel'
            })
        }
	}
} as Command<ContextMenuCommandBuilder>
