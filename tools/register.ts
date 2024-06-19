import { REST, type RESTPostAPIChatInputApplicationCommandsJSONBody, Routes } from "discord.js"
import { readJsonSync } from "../lib/read"
import { select } from "@inquirer/prompts"
import fs from "node:fs"
import type { Command } from "../lib/interaction"

const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = []
const commandFiles = fs
	.readdirSync("./commands")
	.filter(filename => filename.endsWith(".ts"))
const setting = readJsonSync();

(async () => {
	for (const file of commandFiles) {
		const command: Command = (await import(`../commands/${file}`)).default
		if ('data' in command && 'execute' in command) {
			commands.push(command.data.toJSON())
		} else {
			console.log(`Error when loading ${file}`, command)
		}
	}

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

		console.log(
			await rest.put(Routes.applicationCommands(clientId), { body: commands })
		)

		console.log("Successfully reloaded application (/) commands.")
	} catch (error) {
		console.error(error)
	}
})()
