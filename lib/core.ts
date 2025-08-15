import fs from "node:fs";
import { readFile } from "node:fs/promises";
import type {
	ContextMenuCommandBuilder,
	RESTPostAPIChatInputApplicationCommandsJSONBody,
	RESTPostAPIContextMenuApplicationCommandsJSONBody,
	SlashCommandBuilder,
} from "discord.js";
import type { Command } from "./interaction";
import { glob } from "glob";
import { createHash } from "node:crypto";
import { join } from "node:path";

export function getCommandPath(folderName: string): string[] {
	return fs
		.readdirSync(`${__dirname}/../commands/${folderName}`)
		.filter(
			(d) =>
				(d.endsWith(".ts") || d.endsWith(".js")) &&
				!d.endsWith(".d.ts") &&
				!d.endsWith(".map.js"),
		);
}

export function loadCommands<
	T extends SlashCommandBuilder | ContextMenuCommandBuilder,
>(folderName: string): Map<string, Command<T>> {
	const commandFiles = getCommandPath(folderName);
	const commands = new Map<string, Command<T>>();
	for (const file of commandFiles) {
		const command: Command<T> = require(
			`${__dirname}/../commands/${folderName}/${file}`,
		).default;
		commands.set(command.data.name, command);
	}
	return commands;
}

export async function loadCommandsJson<
	T extends SlashCommandBuilder | ContextMenuCommandBuilder,
>(folderName: string) {
	const commands: (
		| RESTPostAPIChatInputApplicationCommandsJSONBody
		| RESTPostAPIContextMenuApplicationCommandsJSONBody
	)[] = [];
	const commandFiles = getCommandPath(folderName);
	for (const file of commandFiles) {
		const command: Command<T> = (
			await import(`../commands/${folderName}/${file}`)
		).default;
		if ("data" in command && "execute" in command) {
			commands.push(command.data.toJSON());
		} else {
			throw new Error(
				`Error when loading ${file}, not meeting requirements`,
			);
		}
	}
	return commands as unknown as (T extends SlashCommandBuilder
		? RESTPostAPIChatInputApplicationCommandsJSONBody
		: RESTPostAPIContextMenuApplicationCommandsJSONBody)[];
}

export async function calculateHash(
	include = "{{lib,commands}/**/*.*,index.ts}",
): Promise<string> {
	const hash = createHash("sha1", {});
	hash.setEncoding("hex");
	const files = (await glob(include)).sort();
	for (const file of files) {
		await new Promise(async (resolve) =>
			hash.write(await readFile(join(process.cwd(), file)), resolve),
		);
	}
	hash.end();
	return hash.read();
}
