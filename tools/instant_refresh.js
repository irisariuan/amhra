const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const { readJsonSync } = require('./lib/read');
const fs = require('fs');

const { select } = require('@inquirer/prompts')

const commands = [];
const commandFiles = fs.readdirSync('./commands').filter(d => d.endsWith('.js'));
const setting = readJsonSync('./data/setting.json');
Object.freeze(setting);

for (const file of commandFiles) {
	const command = require(`./commands/${file}`);
	commands.push(command.data.toJSON());
}

(async () => {
	const result = await select({ choices: [{ name: 'Production', value: 'prod' }, { name: 'Development', value: 'dev' }], message: 'Mode' })
	const token = result === 'prod' ? setting.TOKEN : setting.TESTING_TOKEN
	const clientId = result === 'prod' ? setting.CLIENT_ID : setting.TEST_CLIENT_ID
	
	const rest = new REST({ version: '9' }).setToken(token);
	
	let guildList = ['897409924236197888', '781782289888837654'];

	console.log("Start refreshing commands")
	for (i of guildList) {
		console.log("Trying to refresh guild (ID: " + i + ")")
		try {
			console.log(await rest.put(
				Routes.applicationCommands(clientId),
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
