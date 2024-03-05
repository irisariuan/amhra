const { GatewayIntentBits, MessageType } = require("discord.js")
const fs = require("fs")
const { CustomClient } = require("./custom.js")
const { app, registered, auth } = require("./express/server.js")
const { event } = require("./express/event.js")
const { exp, dcb, globalApp, misc } = require("./misc.js")
const { readJsonSync } = require("./read.js")
const chalk = require("chalk")

const setting = readJsonSync("./data/setting.json")
Object.freeze(setting)

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
	.readdirSync(process.cwd() + "/commands")
	.filter(d => d.endsWith(".js"))
const commands = new Map()

for (const file of commandFiles) {
	const command = require(process.cwd() + `/commands/${file}`)
	commands.set(command.data.name, command)
}

client.on("ready", () => {
	dcb.log(`Logged in as ${client.user?.tag}!`)
})

client.on("interactionCreate", async interaction => {
	if (!interaction.isCommand()) return
	const command = commands.get(interaction.commandName)
	if (!command) {
		globalApp.important('Command not implemented: ' + interaction.commandName)
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
		`${message.author.tag} (Guild ID: ${message.guildId}, Channel ID: ${message.channelId}, Message ID: ${message.id}): '${chalk.bgWhite.black(message.content)}'${message.attachments.length ? `Attachments: ${message.attachments.map(v => `URL: ${v.url}, Type: ${v.contentType}`).join(', ')}` : ''}`
	)
	message.attachments.forEach(v => v.contentType)
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
	dcb.log("Shard Error: " + e)
})

app.get("/api/guildIds", registered, (req, res) => {
	const ids = Array.from(client.player.keys())
	exp.log('Sent guild IDs')
	res.send(JSON.stringify({ ids }))
})

app.get("/api/song/get/:guildId", auth, registered, (req, res) => {
	const data = client.player.get(req.params.guildId)?.getData()
	return res.send(JSON.stringify(data ?? null))
})

module.exports = { client }
