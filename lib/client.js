const { Intents } = require('discord.js');
const fs = require('fs');
const { CustomClient } = require('./custom.js');
const { app, registered } = require('./express/main.js');
const { event } = require('./express/event.js')
const { exp, dcb } = require('./misc.js');
const { readJsonSync } = require('./read.js')

const setting = readJsonSync('./data/setting.json')
Object.freeze(setting)

const client = new CustomClient({
	intents: [
		Intents.FLAGS.GUILDS,
		Intents.FLAGS.GUILD_MESSAGES,
		Intents.FLAGS.GUILDS,
		Intents.FLAGS.GUILD_MEMBERS,
		Intents.FLAGS.GUILD_BANS,
		Intents.FLAGS.GUILD_EMOJIS_AND_STICKERS,
		Intents.FLAGS.GUILD_INTEGRATIONS,
		Intents.FLAGS.GUILD_VOICE_STATES,
		Intents.FLAGS.GUILD_PRESENCES,
		Intents.FLAGS.GUILD_MESSAGES,
		Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
		Intents.FLAGS.GUILD_MESSAGE_TYPING
	]
});



// import commands
const commandFiles = fs.readdirSync(process.cwd() + '/commands').filter(d => d.endsWith('.js'));
const commands = new Map();

for (const file of commandFiles) {
	const command = require(process.cwd() + `/commands/${file}`);
	commands.set(command.data.name, command);
}

client.on('ready', () => {
	dcb.log(`Logged in as ${client.user.tag}!`);
});

client.on('interactionCreate', async interaction => {
	if (!interaction.isCommand()) return;
	const command = commands.get(interaction.commandName);
	if (!command) return;
	try {
		await command.execute(interaction, client)
	} catch (e) {
		console.error(e);
		try {
			await interaction.reply({ content: "An error occured during running this action", ephemeral: true })
		} catch { }
	}
});

client.on('messageCreate', async message => {
	const msg = message.content;
	if (message.author.id !== client.user.id) {
		dcb.log(`${message.author.tag}: ${msg}`);
	}
	if (msg.startsWith(setting.PREFIX)) {
		const args = msg.slice(setting.PREFIX.length).split(' ');
		switch (args.shift()) {
		}
	}
});

client.on('shardError', e => {
	dcb.log('Shard Error: ' + e)
});

app.get('/api/guildIds', registered, (req, res) => {
	const id = Array.from(client.player.keys())
	res.send('OK')
})

event.on('page', pageName => exp.log('Fetched page ' + pageName))

module.exports = { client }