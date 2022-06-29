//@ts-check

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
let guildList = ['897409924236197888'];

(async () => {
    try {
		console.log('Started refreshing application (/) commands.');

        console.log(await rest.put(
            Routes.applicationCommands(setting.CLIENT_ID),
            { body: commands }
        ));

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();
