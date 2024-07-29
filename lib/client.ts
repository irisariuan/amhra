import { type ContextMenuCommandBuilder, GatewayIntentBits, type SlashCommandBuilder, type GuildMember } from 'discord.js'
import { loadCommands } from './core'
import fs from 'node:fs'
import { CustomClient } from './custom'
import { event } from './express/event'
import { dcb, globalApp, misc } from './misc'
import { readJsonSync } from './read'
import { createResource, destroyAudioPlayer, getConnection } from './voice/core'
import { yt_validate } from 'play-dl'
import chalk from 'chalk'
import type { Command } from './interaction'
import { SongEditType } from './express/event'

const setting = readJsonSync()
export const client = new CustomClient({
	intents: [
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.Guilds,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildMessageReactions,
		GatewayIntentBits.GuildMessageTyping,
	],
})

// import commands
let commands = loadCommands<SlashCommandBuilder>('slash')
let contextCommands = loadCommands<ContextMenuCommandBuilder>('context')

client.on('ready', () => {
	dcb.log(`Logged in as ${client.user?.tag}!`)
	dcb.log(`Loaded commands ${Array.from(commands.keys()).join(', ')}`)
	dcb.log(`Loaded context commands ${Array.from(contextCommands.keys()).join(', ')}`)
})

client.on('interactionCreate', async interaction => {
	if (interaction.isUserContextMenuCommand()) {
		const command = contextCommands.get(interaction.commandName)
		if (!command) {
			globalApp.important(`Command not implemented: ${interaction.commandName}`)
			interaction.reply('Command not implemented!')
			return
		}
		try {
			dcb.log(`${misc.createFormattedName((interaction.targetMember || interaction.targetUser || interaction.member) as GuildMember)} called context command ${chalk.bgGray.whiteBright(interaction.commandName)}`)
			await command.execute(interaction, client)
		} catch (e) {
			globalApp.err(e)
			try {
				await interaction.reply(misc.errorMessage)
			} catch {
				globalApp.err('Cannot send error message')
			}
		}
	}
	if (interaction.isChatInputCommand()) {
		const command = commands.get(interaction.commandName)
		if (!command) {
			globalApp.important(`Command not implemented: ${interaction.commandName}`)
			interaction.reply('Command not implemented!')
			return
		}
		try {
			dcb.log(`${misc.createFormattedName(interaction.member as GuildMember)} called command ${chalk.bgGray.whiteBright(interaction.commandName)}`)
			await command.execute(interaction, client)
		} catch (e) {
			globalApp.err(e)
			try {
				await interaction.reply(misc.errorMessage)
			} catch {
				globalApp.err('Cannot send error message')
			}
		}
	}
})

client.on('messageCreate', async message => {
	if (message.author.id === client.user?.id) return
	dcb.messageLog(
		`${message.author.tag} (Guild ID: ${message.guildId}, Channel ID: ${message.channelId}, Message ID: ${message.id}): '${chalk.bgWhite.black(message.content)}'${Array.from(message.attachments.values()).length ? `Attachments: ${message.attachments.map(v => `URL: ${v.url}, Type: ${v.contentType}`).join(', ')}` : ''}`
	)
	if (message.content.startsWith(setting.PREFIX)) {
		const args = message.content.slice(setting.PREFIX.length).split(' ')
		switch (args.shift()) {
			default:
				return
			// todo
		}
	}
})

client.on('messageDelete', message => {
	dcb.messageLog(`${chalk.red('[DELETE]')} ${message.author?.tag} (Guild ID: ${message.guildId}, Channel ID: ${message.channelId}, Message ID: ${message.id}) deleted '${chalk.bgWhite.black(message.content)}''${message.attachments ? `Attachments: ${message.attachments.map(v => `URL: ${v.url}, Type: ${v.contentType}`).join(', ')}` : ''}`)
})

client.on('messageUpdate', (oldMessage, newMessage) => {
	if (oldMessage.author?.id === client.user?.id) return
	if (oldMessage.content === newMessage.content) {
		return
	}
	dcb.messageLog(`${chalk.yellowBright('[EDIT]')} ${newMessage.author?.tag} (Guild ID: ${newMessage.guildId}, Channel ID: ${newMessage.channelId}, Message ID: ${newMessage.id === oldMessage.id ? newMessage.id : `N${newMessage.id}O${oldMessage.id}`}) edited '${chalk.bgWhite.black(oldMessage.content)}' to '${chalk.bgWhite.black(newMessage.content)}'`)
})

client.on('voiceStateUpdate', (oldState, newState) => {
	const formatter = misc.prefixFormatter(`${chalk.bgMagentaBright('[VOICE]')} (Channel ID: ${newState.channelId ?? oldState.channelId}, Guild ID: ${newState.guild.id})`)
	if (!newState.member) {
		return dcb.log(formatter('Member not found'))
	}
	const formattedName = misc.createFormattedName(newState.member)

	if (oldState.channel !== newState.channel) {
		dcb.log(formatter(`${formattedName} ${newState.channel ? 'joined' : 'left'} voice channel`))
	}
	if (oldState.deaf !== newState.deaf) {
		dcb.log(formatter(`${formattedName} is now ${newState.deaf ? 'deafening' : 'hearing'}`))
	}
	if (oldState.mute !== newState.mute) {
		dcb.log(formatter(`${formattedName} is now ${newState.mute ? 'muting' : 'unmuted'}`))
	}
	if (oldState.selfVideo !== newState.selfVideo) {
		dcb.log(formatter(`${formattedName} ${newState.selfVideo ? 'is now streaming' : 'just stopped streaming'}`))
	}
})

client.on('shardError', e => {
	dcb.log(`Shard Error: ${e}`)
})

event.on('songInterruption', async (guildId, action, detail) => {
	const player = client.player.get(guildId)
	if (!player) {
		return globalApp.err('Player not found')
	}
	switch (action) {
		case SongEditType.Pause: {
			player.pause()
			break
		}
		case SongEditType.Resume: {
			player.unpause()
			break
		}
		case SongEditType.SetTime: {
			if (!player.nowPlaying || !player.isPlaying || !detail.sec) {
				return globalApp.err('Cannot interrupt the song since nothing is playing')
			}
			if (detail.sec > player.nowPlaying.details.durationInSec || detail.sec < 0) {
				return globalApp.err('Out of range')
			}

			const res = await createResource(player.nowPlaying.url, detail.sec)
			player.playResource(res)
			dcb.log('Relocated the video')
		}
			break
		case SongEditType.AddSong: {
			dcb.log('Added song from dashboard to queue')
			if (yt_validate(detail.url ?? '') !== 'video' || !detail.url) {
				return globalApp.err('Invalid URL')
			}
			player.addToQueue(detail.url)
			if (!player.isPlaying) {
				const p = player.queue.shift()
				if (!p) return
				const res = await createResource(p)

				event.emitSongInfo(p)
				player.playResource(res)
				dcb.log('Started playing song from queue')
			}
			break
		}
		case SongEditType.Stop: {
			dcb.log('Stop the music from dashboard')
			player.cleanStop()
			break
		}
		case SongEditType.Skip: {
			dcb.log('Skip the music from dashboard')
			player.stop()
			break
		}
		case SongEditType.RemoveSong: {
			if (!detail.index) return globalApp.err('Index is required, given detail:', detail)
			dcb.log('Removing song from dashboard')
			const removedSong = player.queue.splice(detail.index, 1)
			if (removedSong.at(0)) {
				dcb.log(`Removed song URL: ${removedSong[0]}`)
			} else {
				globalApp.err('Out of index')
			}
			break
		}
		case SongEditType.SetVolume: {
			if (!detail.volume) return globalApp.err('Volume is required')
			dcb.log(`Setting volume to ${detail.volume}% from dashboard`)
			const vol = Number.parseFloat(detail.volume)
			if (!Number.isNaN(vol)) {
				player.setVolume(vol)
			}
			break
		}
		case SongEditType.SetQueue: {
			dcb.log('Switching queue from dashboard')
			if (detail.queue) {
				player.queue = detail.queue
			} else {
				globalApp.err('Queue error', detail.queue)
			}
			break
		}
		case SongEditType.Quit: {
			dcb.log('Quitting from dashboard')
			player.stop()
			getConnection(guildId)?.destroy()
			destroyAudioPlayer(client, guildId)
			break
		}
		case SongEditType.Unmute: {
			dcb.log('Unmuting from dashboard')
			player.unmute()
			break
		}
		case SongEditType.Mute: {
			dcb.log('Muting from dashboard')
			player.mute()
			break
		}
		default:
			break
	}
})

event.on('reloadCommands', () => {
	globalApp.important('Reloading commands')
	try {
		commands = loadCommands('slash')
		contextCommands = loadCommands('context')
	} catch (e) {
		globalApp.err(e)
	}
	globalApp.important('Reloaded commands')
})