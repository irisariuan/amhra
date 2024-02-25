const chalk = require("chalk")
const { event } = require("./express/event")
const { appendFile } = require('fs/promises')
const { removeAnsi } = require('ansi-parser')
const { GuildMember } = require("discord.js")

const errorMessage = 'An error occurred during running this command'

async function addLogLine(data, logCategory) {
	appendFile(process.cwd() + '/data/log/' + logCategory + '.log', data + '\n', {
		encoding: 'utf8'
	})
}

module.exports = {
	exp: {
		log(...args) {
			console.log(chalk.magenta("[EXPRESS] ") + args.join())
			event.emit("log", args.join(), "explog")
			addLogLine(removeAnsi(args.join()), 'express')
		},
		error(...args) {
			console.log(chalk.redBright("[EXPRESS_ERROR] ") + args.join())
			event.emit("log", args.join(), "experr")
			addLogLine('Express: ' + removeAnsi(args.join()), 'error')
		},
	},
	dcb: {
		log(...args) {
			console.log(chalk.blue("[DISCORD] ") + args.join())
			event.emit("log", args.join(), "dcblog")
			addLogLine(removeAnsi(args.join()), 'main')
		},
		messageLog(...args) {
			console.log(chalk.blue("[DISCORD] ") + chalk.bgCyanBright("[MESSAGE]") + ' ' + args.join())
			event.emit("log", args.join(), "dcblog")
			addLogLine(removeAnsi(args.join()), 'message')
		}
	},
	globalApp: {
		err(...args) {
			console.log(chalk.red("[ERROR] ") + args.join())
			event.emit("log", args.join(), "error")
			addLogLine(removeAnsi(args.join()), 'error')
		},
		warn(...args) {
			console.log(chalk.yellow("[WARN] ") + args.join())
			event.emit("log", args.join(), "warn")
			addLogLine('Warn:' + removeAnsi(args.join()), 'error')
		},
		important(...args) {
			console.log(
				chalk.bgYellowBright.whiteBright.bold("[IMPORTANT]") + " " + args.join()
			)
			event.emit("log", args.join(), "warn")
			addLogLine('Important: ' + removeAnsi(args.join()), 'error')
		},
	},
	misc: {
		errorMessageObj: {
			content: errorMessage,
			ephemeral: true,
		},
		errorMessage,
		/**
		 * 
		 * @param {string} format 
		 * @returns {(input: string) => string}
		 */
		prefixFormatter(format) {
			/**
			 * @param {string} input
			 */
			return (input) => {
				return `${format} ${input}`
			}
		},
		addLogLine,
		/**
		 * 
		 * @param {GuildMember} member 
		 * @returns 
		 */
		createFormattedName(member) {
			return `${member?.nickname ?? member?.user?.displayName} (${member?.user?.tag}, ID: ${member?.user?.id})`
		}
	},
}
