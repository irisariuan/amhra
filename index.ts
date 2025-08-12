import { initServer } from "./lib/express/server";
import { client } from "./lib/client";
import { select } from "@inquirer/prompts";
import chalk from "chalk";
import { readSetting } from "./lib/setting";
import { exp, globalApp } from "./lib/misc";

const setting = readSetting();

(async () => {
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
