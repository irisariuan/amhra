import {
	ApplicationCommandOptionType,
	ApplicationCommandType,
	REST,
	RESTPostAPIChatInputApplicationCommandsJSONBody,
	RESTPostAPIContextMenuApplicationCommandsJSONBody,
	Routes,
	type SlashCommandBuilder,
} from "discord.js";
import { readSetting } from "../lib/setting";
import { select } from "@inquirer/prompts";
import { loadCommandsJson } from "../lib/core";
import {
	CommandLocale,
	languageCommandName,
	parseLanguageToLocale,
} from "../lib/language";
import { Language } from "../lib/interaction";

const setting = readSetting();

function loadLocale(
	command:
		| RESTPostAPIChatInputApplicationCommandsJSONBody
		| RESTPostAPIContextMenuApplicationCommandsJSONBody,
) {
	for (const lang of Object.values(Language).filter(
		(v) => v !== Language.Unsupported,
	)) {
		const locale = languageCommandName(command.name, lang);
		if (!locale) continue;
		if (!command.name_localizations) command.name_localizations = {};
		if (locale.name) {
			console.log(`Loaded locale name ${lang} for ${command.name}`);
			command.name_localizations[parseLanguageToLocale(lang)] =
				locale.name;
		}
		if (!command.description_localizations)
			command.description_localizations = {};
		if (locale.description) {
			console.log(
				`Loaded locale description ${lang} for ${command.name}`,
			);
			command.description_localizations[parseLanguageToLocale(lang)] =
				locale.description;
		}
		if (locale.options && command.options) {
			for (const option of command.options) {
				const localeOption = locale.options[option.name];
				if (!localeOption) continue;
				if (localeOption.name) {
					if (!option.name_localizations)
						option.name_localizations = {};
					option.name_localizations[parseLanguageToLocale(lang)] =
						localeOption.name;
					console.log(
						`Loaded locale name ${lang} for option ${option.name} of ${command.name}`,
					);
				}
				if (localeOption.description) {
					if (!option.description_localizations)
						option.description_localizations = {};
					option.description_localizations[
						parseLanguageToLocale(lang)
					] = localeOption.description;
					console.log(
						`Loaded locale description ${lang} for option ${option.name} of ${command.name}`,
					);
				}
				if (
					option.type ===
						ApplicationCommandOptionType.SubcommandGroup &&
					localeOption.options
				) {
					for (const subOption of option.options ?? []) {
						const localeSubOption =
							localeOption.options[subOption.name];
						if (!localeSubOption) continue;
						if (localeSubOption.name) {
							if (!subOption.name_localizations)
								subOption.name_localizations = {};
							subOption.name_localizations[
								parseLanguageToLocale(lang)
							] = localeSubOption.name;
							console.log(
								`Loaded locale name ${lang} for sub-option ${subOption.name} of ${option.name} of ${command.name}`,
							);
						}
						if (localeSubOption.description) {
							if (!subOption.description_localizations)
								subOption.description_localizations = {};
							subOption.description_localizations[
								parseLanguageToLocale(lang)
							] = localeSubOption.description;
							console.log(
								`Loaded locale description ${lang} for sub-option ${subOption.name} of ${option.name} of ${command.name}`,
							);
						}
					}
				}
			}
		}
	}
}

(async () => {
	const commands = await loadCommandsJson<SlashCommandBuilder>("slash");
	const contextCommands = await loadCommandsJson("context");
	for (const command of commands) {
		loadLocale(command);
	}
	for (const command of contextCommands) {
		loadLocale(command);
	}

	console.log(`Loaded commands ${commands.map((c) => c.name).join(", ")}`);
	console.log(
		`Loaded context commands ${contextCommands.map((c) => c.name).join(", ")}`,
	);
	const result = await select({
		choices: [
			{ name: "Production", value: "prod" },
			{ name: "Development", value: "dev" },
		],
		message: "Mode",
	});
	const token = result === "prod" ? setting.TOKEN : setting.TESTING_TOKEN;
	const clientId =
		result === "prod" ? setting.CLIENT_ID : setting.TEST_CLIENT_ID;

	const rest = new REST({ version: "9" }).setToken(token);
	try {
		console.log("Started refreshing application (/) commands.");

		await rest.put(Routes.applicationCommands(clientId), {
			body: [...commands, ...contextCommands],
		});

		console.log("Successfully reloaded application (/) commands.");
	} catch (error) {
		console.error(error);
	}
})();
