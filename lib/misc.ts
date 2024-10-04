import type { APIInteractionGuildMember, GuildMember } from "discord.js"
import chalk from "chalk"
import { event } from "./express/event"
import { appendFile } from 'node:fs/promises'
import { removeAnsi } from 'ansi-parser'

export const errorMessage = 'An error occurred during running this command'

export async function addLogLine(data, logCategory) {
	appendFile(`${process.cwd()}/data/log/${logCategory}.log`, `T${Date.now()}: ${data}\n`, {
		encoding: 'utf8'
	})
}
export function baseLog(...data) {
	console.log(chalk.gray.italic(`T${Date.now()}`), ...data)
}

export function baseError(...data) {
	console.error(chalk.gray.italic(`T${Date.now()}`), ...data)
}

export const exp = {
	log(...args) {
		baseLog(chalk.magenta("[EXPRESS] ") + args.join())
		event.emit("log", removeAnsi(args.join()), "explog")
		addLogLine(removeAnsi(args.join()), 'express')
	},
	error(...args) {
		baseLog(chalk.redBright("[EXPRESS_ERROR] ") + args.join())
		event.emit("log", removeAnsi(args.join()), "experr")
		addLogLine(`Express: ${removeAnsi(args.join())}`, 'error')
	},
}

export const dcb = {
	log(...args) {
		baseLog(chalk.blue("[DISCORD] ") + args.join())
		event.emit("log", removeAnsi(args.join()), "dcblog")
		addLogLine(removeAnsi(args.join()), 'main')
	},
	messageLog(...args) {
		baseLog(`${chalk.blue("[DISCORD] ") + chalk.bgCyanBright.grey("[MESSAGE]")} ${args.join()}`)
		event.emit("log", removeAnsi(args.join()), "dcbmsg")
		addLogLine(removeAnsi(args.join()), 'message')
	}
}

export const globalApp = {
	err(...args) {
		baseError(chalk.red('[ERROR]') ,...args)
		event.emit("log", removeAnsi(args.join()), "error")
		addLogLine(removeAnsi(args.join()), 'error')
	},
	warn(...args) {
		baseLog(chalk.yellow("[WARN] ") + args.join())
		event.emit("log", removeAnsi(args.join()), "warn")
		addLogLine(`Warn: ${removeAnsi(args.join())}`, 'errwn')
	},
	important(...args) {
		baseLog(
			`${chalk.bgYellowBright.whiteBright.bold("[IMPORTANT]")} ${args.join()}`
		)
		event.emit("log", removeAnsi(args.join()), "important")
		addLogLine(`Important: ${removeAnsi(args.join())}`, 'errim')
	},
}


export const misc = {
	errorMessageObj: {
		content: errorMessage,
		ephemeral: true,
	},
	errorMessage,
	prefixFormatter(format: string): (input: string) => string {
		/**
		 * @param {string} input
		 * @returns {string}
		 */
		return (input) => {
			return `${format} ${input}`
		}
	},
	addLogLine,
	createFormattedName(member: GuildMember) {
		return `${member?.nickname ?? member?.user?.displayName} (${member?.user?.tag}, ID: ${member?.user?.id})`
	},
	generateToken(n: number) {
		const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
		let token = ''
		for (let i = 0; i < n; i++) {
			token += chars[Math.floor(Math.random() * chars.length)]
		}
		return token
	},
	removeBearer(input: string) {
		if (input.startsWith('Bearer ')) {
			return input.slice(7)
		}
		return input
	}
}
