//@ts-check

const { app } = require('./lib/express/main.js')
const { client } = require('./lib/client.js')
const { select } = require('@inquirer/prompts')
const chalk = require('chalk')
const { readJsonSync } = require('./lib/read.js')
const { exp, globalApp } = require('./lib/misc.js')

const setting = readJsonSync('./data/setting.json')
Object.freeze(setting)

process.on('uncaughtException', e => {
    globalApp.err('Uncaught Error: ' + e)
})

process.on('unhandledRejection', error => {
	console.error('Unhandled promise rejection:', error)
});


(async () => {
	
	const result = await select({ choices: [{ name: 'Production', value: 'prod' }, { name: 'Development', value: 'dev' }], message: 'Mode' })

	const token = { 'prod': setting.TOKEN, 'dev': setting.TESTING_TOKEN }[result]

	if (result === 'dev') {
		app.listen(setting.PORT, () => exp.log(chalk.blue.bold('Listening on port ') + chalk.greenBright.italic(setting.PORT)))
	}
	client.login(token)
})()