const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const { readJsonSync } = require('../lib/read');
const { select } = require('@inquirer/prompts')
const fs = require('fs');

const commands = [];
const commandFiles = fs.readdirSync('./commands').filter(d => d.endsWith('.js'));
const setting = readJsonSync('./data/setting.json');
Object.freeze(setting);

for (const file of commandFiles) {
    const command = require(`../commands/${file}`)
    commands.push(command.data.toJSON());
}

(async () => {
    const result = await select({ choices: [{ name: 'Production', value: 'prod' }, { name: 'Development', value: 'dev' }], message: 'Mode' })
	const token = result === 'prod' ? setting.TOKEN : setting.TESTING_TOKEN
	const clientId = result === 'prod' ? setting.CLIENT_ID : setting.TEST_CLIENT_ID
    
    const rest = new REST({ version: '9' }).setToken(token);
    try {
		console.log('Started refreshing application (/) commands.');

        console.log(await rest.put(
            Routes.applicationCommands(clientId),
            { body: commands }
        ));

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();