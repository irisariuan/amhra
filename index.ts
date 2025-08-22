import { select } from "@inquirer/prompts";
import chalk from "chalk";
import { client } from "./lib/client";
import { calculateHash } from "./lib/core";
import { exp, globalApp } from "./lib/misc";
import { initServer } from "./lib/server/core";
import { readSetting } from "./lib/setting";
import { watch } from "node:fs";

const setting = readSetting();

(async () => {
	const hash = await calculateHash();
	console.log(`Running on version ${chalk.bold(hash)}`);
	let result: "prod" | "dev";
	if (process.argv.includes("--prod") && setting.TOKEN) {
		console.log(chalk.bgGreen.whiteBright("Flagged Production Mode"));
		result = "prod";
	} else {
		const choices: { name: string; value: "prod" | "dev" }[] = [];
		if (setting.TOKEN) {
			choices.push({ name: "Production", value: "prod" });
		}
		if (setting.TESTING_TOKEN) {
			choices.push({ name: "Development", value: "dev" });
		}
		if (choices.length === 0) {
			return console.log(chalk.bgRed.whiteBright("No token is provided"));
		}
		result = await select({ choices: choices, message: "Mode" });
	}
	if (result === "prod") {
		process.on("uncaughtException", (e) => {
			globalApp.err(`Uncaught Error: ${e}`);
		});

		process.on("unhandledRejection", (error) => {
			globalApp.err("Unhandled promise rejection:", error);
		});
		const watchHandler = async () => {
			const newHash = await calculateHash();
			if (newHash !== hash) {
				console.log(
					chalk.yellow(
						`You are on version ${chalk.bold(hash)}, while the newest version is ${chalk.bold(newHash)}`,
					),
				);
			}
		};
		if (!process.argv.includes("--no-version-warning")) {
			watch("index.ts", { recursive: true }, watchHandler);
			watch("lib", { recursive: true }, watchHandler);
			watch("commands", { recursive: true }, watchHandler);
		}
	}

	const token = { prod: setting.TOKEN, dev: setting.TESTING_TOKEN }[result];
	const app = await initServer(client);
	app.listen(setting.PORT, () =>
		exp.log(
			chalk.blue.bold("Listening on port ") +
				chalk.greenBright.italic(setting.PORT),
		),
	);
	client.login(token);
})();
