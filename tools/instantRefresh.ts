import { REST } from '@discordjs/rest'
import { Routes } from 'discord-api-types/v9'
import { readJsonSync } from '../lib/read'
import fs from 'node:fs'
import { select } from '@inquirer/prompts'
import type { Command } from '../lib/interaction'
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js'

const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = []
const commandFiles = fs.readdirSync('./commands').filter(d => d.endsWith('.js'))
const setting = readJsonSync('./data/setting.json');

(async () => {
	for (const file of commandFiles) {
		const command: Command = (await import(`../commands/${file}`)).default
		commands.push(command.data.toJSON())
	}
	const result = await select({ choices: [{ name: 'Production', value: 'prod' }, { name: 'Development', value: 'dev' }], message: 'Mode' })
	const token = result === 'prod' ? setting.TOKEN : setting.TESTING_TOKEN
	const clientId = result === 'prod' ? setting.CLIENT_ID : setting.TEST_CLIENT_ID

	const rest = new REST({ version: '9' }).setToken(token)

	const guildList = []

	console.log("Start refreshing commands")
	for (const i of guildList) {
		console.log(`Trying to refresh guild (ID: ${i})`)
		try {
			console.log(await rest.put(
				Routes.applicationCommands(clientId),
				{
					body: commands
				}
			))
		} catch (e) {
			console.error(e)
		}
	}
	console.log("Finished")
})()
