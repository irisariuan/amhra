import { REST, Routes, type SlashCommandBuilder } from "discord.js"
import { readJsonSync } from "../lib/read"
import { select } from "@inquirer/prompts"
import { loadCommandsJson } from "../lib/core"

const setting = readJsonSync();

(async () => {
	const commands = await loadCommandsJson<SlashCommandBuilder>('slash')
	const contextCommands = await loadCommandsJson('context')
	console.log(`Loaded commands ${commands.map(c => c.name).join(', ')}`)
	console.log(`Loaded context commands ${contextCommands.map(c => c.name).join(', ')}`)
	const result = await select({
		choices: [
			{ name: "Production", value: "prod" },
			{ name: "Development", value: "dev" },
		],
		message: "Mode",
	})
	const token = result === "prod" ? setting.TOKEN : setting.TESTING_TOKEN
	const clientId =
		result === "prod" ? setting.CLIENT_ID : setting.TEST_CLIENT_ID

	const rest = new REST({ version: "9" }).setToken(token)
	try {
		console.log("Started refreshing application (/) commands.")

		await rest.put(Routes.applicationCommands(clientId), { body: [...commands, ...contextCommands] })

		console.log("Successfully reloaded application (/) commands.")
	} catch (error) {
		console.error(error)
	}
})()
