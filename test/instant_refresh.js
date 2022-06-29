const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const { readJsonSync } = require('./lib/read');
const fs = require('fs');

const { Client, Intents } = require('discord.js');

const commands = [];
const commandFiles = fs.readdirSync('./commands').filter(d => d.endsWith('.js'));
const setting = readJsonSync('./data/setting.json');
Object.freeze(setting);

for (const file of commandFiles) {
	const command = require(`./commands/${file}`);
	commands.push(command.data.toJSON());
}

const rest = new REST({ version: '9' }).setToken(setting.TOKEN);
let guildList = ['897409924236197888', '781782289888837654'];

(async () => {
	console.log("Start refreshing commands")
	for (i of guildList) {
	console.log("Trying to refresh guild (ID: "+i+")")
		try {
			console.log(await rest.put(
				Routes.applicationCommands(setting.CLIENT_ID),
				{
					body: commands
				}
			));
		} catch (e) {
			console.error(e);
		}
	}
	console.log("Finished")
})();
