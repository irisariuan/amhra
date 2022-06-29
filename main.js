const { Client, Intents } = require('discord.js');
const { readJson, readJsonSync } = require('./lib/read.js');
const fs = require('fs');

process.on('uncaughtException', e => {
	console.log('Uncaught Error: ' + e)
})

const client = new Client({ intents: [
	Intents.FLAGS.GUILDS,
	Intents.FLAGS.GUILD_MESSAGES,
	Intents.FLAGS.GUILDS,
	Intents.FLAGS.GUILD_MEMBERS,
	Intents.FLAGS.GUILD_BANS,
	Intents.FLAGS.GUILD_EMOJIS_AND_STICKERS,
	Intents.FLAGS.GUILD_INTEGRATIONS,
	Intents.FLAGS.GUILD_WEBHOOKS,
	Intents.FLAGS.GUILD_INVITES,
	Intents.FLAGS.GUILD_VOICE_STATES,
	Intents.FLAGS.GUILD_PRESENCES,
	Intents.FLAGS.GUILD_MESSAGES,
	Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
	Intents.FLAGS.GUILD_MESSAGE_TYPING,
	Intents.FLAGS.DIRECT_MESSAGES,
	Intents.FLAGS.DIRECT_MESSAGE_REACTIONS,
	Intents.FLAGS.DIRECT_MESSAGE_TYPING,
	Intents.FLAGS.GUILD_SCHEDULED_EVENTS
]});

const setting = readJsonSync('./data/setting.json');
Object.freeze(setting);

// import commands
const commandFiles = fs.readdirSync('./commands').filter(d => d.endsWith('.js'));
const commands = new Map();

for (const file of commandFiles) {
	const command = require(`./commands/${file}`);
	commands.set(command.data.name, command);
}

client.on('ready', () => {
	//initialize for commands
	client.player = new Map();
	
	console.log(`Logged in as ${client.user.tag}!`);
});

client.on('interactionCreate', async interaction => {
	if (!interaction.isCommand()) return;
	const command = commands.get(interaction.commandName);
	if (!command) return;
	try {
		await command.execute(interaction, client)
	} catch (e) {
		console.error(e);
		await interaction.reply({content: "An error occured during running this action", ephemeral:true})
	}
});

client.on('messageCreate', async message => {
	const msg = message.content;
	if (message.author.id !== client.user.id) {
		console.log(`${message.author.tag}: ${msg}`);
	}
	if (msg.startsWith(setting.PREFIX)) {
		const args = msg.slice(setting.PREFIX.length).split(' ');
		switch (args.shift()) {
		}
	}
});

client.on('shardError', e => {
	console.log('Shard Error: ' + e)
});

process.on('unhandledRejection', error => {
	console.error('Unhandled promise rejection:', error);
});

(async () => {
	client.login(setting.TOKEN);
})()
