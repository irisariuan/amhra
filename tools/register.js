//@ts-check

const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const { readJsonSync } = require('../lib/read');
const fs = require('fs');

const commands = [];
const commandFiles = fs.readdirSync('./commands').filter(d => d.endsWith('.js'));
const setting = readJsonSync('./data/setting.json');
Object.freeze(setting);

console.log(commandFiles)

for (const file of commandFiles) {
    const command = require(`../commands/${file}`);
    console.log(command)
    commands.push(command.data.toJSON());
}

const rest = new REST({ version: '9' }).setToken(setting.TOKEN);

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
