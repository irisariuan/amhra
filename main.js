const { app } = require("./lib/express/main.js")
const { client } = require("./lib/client.js")
const { select } = require("@inquirer/prompts")
const chalk = require("chalk")
const { readJsonSync } = require("./lib/read.js")
const { exp, globalApp } = require("./lib/misc.js")

const setting = readJsonSync("./data/setting.json")

process.on("uncaughtException", e => {
	globalApp.err("Uncaught Error: " + e)
})

process.on("unhandledRejection", error => {
	globalApp.err("Unhandled promise rejection:", error)
})

;(async () => {
	const choices = []
	if (setting.TOKEN) {
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

	app.listen(setting.PORT, () =>
		exp.log(
			chalk.blue.bold("Listening on port ") +
				chalk.greenBright.italic(setting.PORT)
		)
	)
	client.login(token)
})()
