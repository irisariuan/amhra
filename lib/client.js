const { GatewayIntentBits } = require("discord.js")
const fs = require("fs")
const { CustomClient } = require("./custom.js")
const { app, registered } = require("./express/main.js")
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
	if (!command) return
	try {
		await command.execute(interaction, client)
	} catch (e) {
		globalApp.err(e)
		try {
			await interaction.reply(misc.errorMessage)
		} catch {
			globalApp.err('Cannot send error message')
		}
	}
})

client.on("messageCreate", async message => {
	const msg = message.content
	if (message.author.id !== client.user?.id) {
		dcb.log(chalk.bgCyanBright('[MESSAGE_LOG] ') + `${message.author.tag}: ${msg}`)
	}
	if (msg.startsWith(setting.PREFIX)) {
		const args = msg.slice(setting.PREFIX.length).split(" ")
		switch (args.shift()) {
			default:
				return
			// todo
		}
	}
})

client.on("shardError", e => {
	dcb.log("Shard Error: " + e)
})

app.get("/api/guildIds", registered, (req, res) => {
	const id = Array.from(client.player.keys())
	res.send("OK")
})

event.on("page", pageName => exp.log("Fetched page " + pageName))

module.exports = { client }
