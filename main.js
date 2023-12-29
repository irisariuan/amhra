const { Intents } = require('discord.js');
const { readJsonSync } = require('./lib/read.js');
const fs = require('fs');
const { select } = require('@inquirer/prompts')
const { CustomClient } = require('./lib/custom.js');

process.on('uncaughtException', e => {
	console.log('Uncaught Error: ' + e)
})

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
		try {
			await interaction.reply({ content: "An error occured during running this action", ephemeral: true })
		} catch { }
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
	const result = await select({ choices: [{ name: 'Production', value: setting.TOKEN },{ name: 'Development', value: setting.TESTING_TOKEN }], message: 'Mode' })
	client.login(result);
})()
