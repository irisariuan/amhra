import { init } from "./lib/express/server"
import { client } from "./lib/client"
import { select } from "@inquirer/prompts"
import chalk from "chalk"
import { readJsonSync } from "./lib/read"
import { exp, globalApp } from "./lib/misc"

const setting = readJsonSync()

	; (async () => {
		const choices: { name: string, value: 'prod' | 'dev' }[] = []
		if (setting.TOKEN) {
			process.on("uncaughtException", e => {
				globalApp.err(`Uncaught Error: ${e}`)
			})

			process.on("unhandledRejection", error => {
				globalApp.err("Unhandled promise rejection:", error)
			})
			choices.push({ name: "Production", value: "prod" })
		}
		if (setting.TESTING_TOKEN) {
			choices.push({ name: "Development", value: "dev" })
		}
		if (choices.length === 0) {
			return console.log(chalk.bgRed.whiteBright("No token is provided"))
		}
		const result = await select({ choices: choices, message: "Mode" })

		const token = { prod: setting.TOKEN, dev: setting.TESTING_TOKEN }[result]
		const app = await init(client)
		app.listen(setting.PORT, () =>
			exp.log(
				chalk.blue.bold("Listening on port ") +
				chalk.greenBright.italic(setting.PORT)
			)
		)
		client.login(token)
	})()
