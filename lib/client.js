const { GatewayIntentBits, MessageType } = require("discord.js")
const fs = require("node:fs")
const { CustomClient } = require("./custom.js")
const { event } = require("./express/event.js")
const { exp, dcb, globalApp, misc } = require("./misc.js")
const { readJsonSync } = require("./read.js")
const { createResource } = require('./voice/core')
const { yt_validate } = require('play-dl')
const chalk = require("chalk")

const setting = readJsonSync("./data/setting.json")
const client = new CustomClient({
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
const commandFiles = fs
	.readdirSync(`${process.cwd()}/commands`)
	.filter(d => d.endsWith(".js"))
const commands = new Map()

for (const file of commandFiles) {
	const command = require(`${process.cwd()}/commands/${file}`)
	commands.set(command.data.name, command)
}

client.on("ready", () => {
	dcb.log(`Logged in as ${client.user?.tag}!`)
})

client.on("interactionCreate", async interaction => {
	if (!interaction.isCommand()) return
	const command = commands.get(interaction.commandName)
	if (!command) {
		globalApp.important(`Command not implemented: ${interaction.commandName}`)
		return interaction.reply('Command not implemented!')
	}
	try {
		dcb.log(`${misc.createFormattedName(interaction.member)} called command ${chalk.bgGray.whiteBright(interaction.commandName)}`)
		await command.execute(interaction, client)
	} catch (e) {
		globalApp.err(e)
		try {
			await interaction.reply(misc.errorMessage)
		} catch {
			globalApp.err("Cannot send error message")
		}
	}
})

client.on("messageCreate", async message => {
	if (message.author.id === client.user?.id) return
	dcb.messageLog(
		`${message.author.tag} (Guild ID: ${message.guildId}, Channel ID: ${message.channelId}, Message ID: ${message.id}): '${chalk.bgWhite.black(message.content)}'${Array.from(message.attachments.values()).length ? `Attachments: ${message.attachments.map(v => `URL: ${v.url}, Type: ${v.contentType}`).join(', ')}` : ''}`
	)
	if (message.content.startsWith(setting.PREFIX)) {
		const args = message.content.slice(setting.PREFIX.length).split(" ")
		switch (args.shift()) {
			default:
				return
			// todo
		}
	}
})

client.on('messageDelete', message => {
	dcb.messageLog(`${chalk.red('[DELETE]')} ${message.author.tag} (Guild ID: ${message.guildId}, Channel ID: ${message.channelId}, Message ID: ${message.id}) deleted '${chalk.bgWhite.black(message.content)}''${message.attachments ? `Attachments: ${message.attachments.map(v => `URL: ${v.url}, Type: ${v.contentType}`).join(', ')}` : ''}`)
})

client.on('messageUpdate', (oldMessage, newMessage) => {
	if (oldMessage.author.id === client.user?.id) return
	if (oldMessage.content === newMessage.content) {
		return
	}
	dcb.messageLog(`${chalk.yellowBright('[EDIT]')} ${newMessage.author.tag} (Guild ID: ${newMessage.guildId}, Channel ID: ${newMessage.channelId}, Message ID: ${newMessage.id === oldMessage.id ? newMessage.id : `N${newMessage.id}O${oldMessage.id}`}) edited '${chalk.bgWhite.black(oldMessage.content)}' to '${chalk.bgWhite.black(newMessage.content)}'`)
})

client.on('voiceStateUpdate', (oldState, newState) => {
	const formatter = misc.prefixFormatter(`${chalk.bgMagentaBright('[VOICE]')} (Channel ID: ${newState.channelId ?? oldState.channelId}, Guild ID: ${newState.guild.id})`)
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

client.on("shardError", e => {
	dcb.log(`Shard Error: ${e}`)
})

event.on("songInterruption", async (guildId, action, detail) => {
	const player = client.player.get(guildId)
	if (!player) {
		return globalApp.err("Player not found")
	}
	switch (action) {
		case "pause": {
			player.pause()
			break
		}
		case "resume": {
			player.unpause()
			break
		}
		case "setTime":
			{
				if (!player.nowPlaying || !player.isPlaying) {
					return globalApp.err("Cannot interrupt the song since nothing is playing")
				}
				if (detail.sec > player.nowPlaying.details.durationInSec || detail.sec < 0) {
					return globalApp.err("Out of range")
				}

				const res = await createResource(player.nowPlaying.url, detail.sec)
				player.playResource(res)
				dcb.log('Relocated the video')
			}
			break
		case "addSong": {
			dcb.log("Added song from dashboard to queue")
			if (yt_validate(detail.url ?? '') !== 'video') {
				return globalApp.err("Invalid URL")
			}
			player.addToQueue(detail.url)
			if (!player.isPlaying) {
				const p = player.queue.shift()
				const res = await createResource(p)

				event.emit("songInfo", p)
				player.playResource(res)
				dcb.log("Started playing song from queue")
			}
			break
		}
		case "stop": {
			dcb.log("Stop the music from dashboard")
			player.cleanStop()
			break
		}
		case "skip": {
			dcb.log("Skip the music from dashboard")
			player.stop()
			break
		}
		case 'removeSong': {
			dcb.log('Removing song from dashboard')
			const removedSong = player.queue.splice(detail.index, 1)
			if (removedSong.at(0)) {
				dcb.log(`Removed song URL: ${removedSong[0]}`)
			} else {
				globalApp.err('Out of index')
			}
			break
		}
		case 'setVolume': {
			dcb.log(`Setting volume to ${detail.volume}% from dashboard`)
			const vol = Number.parseFloat(detail.volume)
			if (!Number.isNaN(vol)) {
				player.setVolume(Number.parseFloat(detail.volume))
			}
			break
		}
		case 'setQueue': {
			dcb.log('Switching queue from dashboard')
			if (detail.queue) {
				player.queue = detail.queue
			} else {
				globalApp.err('Queue error', detail.queue)
			}
			break
		}
		default:
			break
	}
})

module.exports = { client }
