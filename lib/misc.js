const chalk = require("chalk")
const { event } = require("./express/event")
const { appendFile } = require('fs/promises')
const { removeAnsi } = require('ansi-parser')
const { GuildMember } = require("discord.js")

const errorMessage = 'An error occurred during running this command'

async function addLogLine(data, logCategory) {
	appendFile(process.cwd() + '/data/log/' + logCategory + '.log', `T${Date.now()}: ` + data + '\n', {
		encoding: 'utf8'
	})
}
function baseLog(...data) {
	console.log(chalk.gray.italic(`T${Date.now()}`), ...data)
}

module.exports = {
	baseLog,
	exp: {
		log(...args) {
			baseLog(chalk.magenta("[EXPRESS] ") + args.join())
			event.emit("log", removeAnsi(args.join()), "explog")
			addLogLine(removeAnsi(args.join()), 'express')
		},
		error(...args) {
			baseLog(chalk.redBright("[EXPRESS_ERROR] ") + args.join())
			event.emit("log", removeAnsi(args.join()), "experr")
			addLogLine('Express: ' + removeAnsi(args.join()), 'error')
		},
	},
	dcb: {
		log(...args) {
			baseLog(chalk.blue("[DISCORD] ") + args.join())
			event.emit("log", removeAnsi(args.join()), "dcblog")
			addLogLine(removeAnsi(args.join()), 'main')
		},
		messageLog(...args) {
			baseLog(chalk.blue("[DISCORD] ") + chalk.bgCyanBright.grey("[MESSAGE]") + ' ' + args.join())
			event.emit("log", removeAnsi(args.join()), "dcbmsg")
			addLogLine(removeAnsi(args.join()), 'message')
		}
	},
	globalApp: {
		err(...args) {
			baseLog(chalk.red("[ERROR] ") + args.join())
			event.emit("log", removeAnsi(args.join()), "error")
			addLogLine(removeAnsi(args.join()), 'error')
		},
		warn(...args) {
			baseLog(chalk.yellow("[WARN] ") + args.join())
			event.emit("log", removeAnsi(args.join()), "warn")
			addLogLine('Warn:' + removeAnsi(args.join()), 'errwn')
		},
		important(...args) {
			baseLog(
				chalk.bgYellowBright.whiteBright.bold("[IMPORTANT]") + " " + args.join()
			)
			event.emit("log", removeAnsi(args.join()), "important")
			addLogLine('Important: ' + removeAnsi(args.join()), 'errim')
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
