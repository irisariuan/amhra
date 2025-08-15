import type { GuildMember } from "discord.js"
import chalk from "chalk"
import { event } from "./server/event"
import { appendFile, writeFile } from 'node:fs/promises'
import removeAnsi from 'strip-ansi'
import { existsSync } from "node:fs"



export const errorMessage = 'An error occurred during running this command'

export async function addLogLine(data: string, logCategory: string) {
	if (!existsSync(`${process.cwd()}/data/log/${logCategory}.log`)) {
		await writeFile(`${process.cwd()}/data/log/${logCategory}.log`, '');
	}
	await appendFile(`${process.cwd()}/data/log/${logCategory}.log`, `T${Date.now()}: ${data}\n`, {
		encoding: 'utf8'
	})
}
export function baseLog(...data: unknown[]) {
	console.log(chalk.gray.italic(`T${Date.now()}`), ...data)
}

export function baseError(...data: unknown[]) {
	console.error(chalk.gray.italic(`T${Date.now()}`), ...data)
}

export const exp = {
	log(...args: unknown[]) {
		baseLog(chalk.magenta("[EXPRESS] ") + args.join())
		event.emit("log", removeAnsi(args.join()), "explog")
		addLogLine(removeAnsi(args.join()), 'express')
	},
	error(...args: unknown[]) {
		baseLog(chalk.redBright("[EXPRESS_ERROR] ") + args.join())
		event.emit("log", removeAnsi(args.join()), "experr")
		addLogLine(`Express: ${removeAnsi(args.join())}`, 'error')
	},
}

export const dcb = {
	log(...args: unknown[]) {
		baseLog(chalk.blue("[DISCORD] ") + args.join())
		event.emit("log", removeAnsi(args.join()), "dcblog")
		addLogLine(removeAnsi(args.join()), 'main')
	},
	messageLog(...args: unknown[]) {
		baseLog(`${chalk.blue("[DISCORD] ") + chalk.bgCyanBright.grey("[MESSAGE]")} ${args.join()}`)
		event.emit("log", removeAnsi(args.join()), "dcbmsg")
		addLogLine(removeAnsi(args.join()), 'message')
	}
}

export const globalApp = {
	err(...args: unknown[]) {
		baseError(chalk.red('[ERROR]') ,...args)
		event.emit("log", removeAnsi(args.join()), "error")
		addLogLine(removeAnsi(args.join()), 'error')
	},
	warn(...args: unknown[]) {
		baseLog(chalk.yellow("[WARN] ") + args.join())
		event.emit("log", removeAnsi(args.join()), "warn")
		addLogLine(`Warn: ${removeAnsi(args.join())}`, 'errwn')
	},
	important(...args: unknown[]) {
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
