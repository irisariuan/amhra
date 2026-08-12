import chalk from "chalk";
import {
	type ContextMenuCommandBuilder,
	GatewayIntentBits,
	type GuildMember,
	type SlashCommandBuilder,
} from "discord.js";
import { loadCommands } from "./core";
import { CustomClient } from "./custom";
import { event } from "./server/event";
import { dcb, globalApp, misc } from "./misc";
import { languageText, parseLocale } from "./language";

export const client = new CustomClient({
	// Every confirmation goes through message components, so no reaction or
	// message content intent is needed.
	intents: [GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.Guilds],
});

// import commands
let commands = loadCommands<SlashCommandBuilder>("slash");
let contextCommands = loadCommands<ContextMenuCommandBuilder>("context");

client.on("ready", () => {
	dcb.log(`Logged in as ${client.user?.tag}!`);
	dcb.log(`Loaded commands ${Array.from(commands.keys()).join(", ")}`);
	dcb.log(
		`Loaded context commands ${Array.from(contextCommands.keys()).join(", ")}`,
	);
});

client.on("interactionCreate", async (interaction) => {
	const language = parseLocale(interaction.locale);
	if (interaction.isUserContextMenuCommand()) {
		const command = contextCommands.get(interaction.commandName);
		if (!command) {
			globalApp.important(
				`Command not implemented: ${interaction.commandName}`,
			);
			interaction.reply(
				languageText("command_not_implemented", language),
			);
			return;
		}
		try {
			dcb.log(
				`${misc.createFormattedName((interaction.targetMember || interaction.targetUser || interaction.member) as GuildMember)} called context command ${chalk.bgGray.whiteBright(interaction.commandName)}`,
			);
			await command.execute({
				interaction,
				client,
				language,
			});
		} catch (e) {
			globalApp.err(e);
			await interaction
				.reply(misc.errorMessageObj(language))
				.catch(async () => {
					await interaction
						.editReply(misc.errorMessageObj(language))
						.catch(async () => {
							await interaction
								.followUp(misc.errorMessageObj(language))
								.catch(() => {
									globalApp.err("Cannot send error message");
								});
						});
				});
		}
	}
	if (interaction.isChatInputCommand()) {
		const command = commands.get(interaction.commandName);
		if (!command) {
			globalApp.important(
				`Command not implemented: ${interaction.commandName}`,
			);
			interaction.reply(
				languageText("command_not_implemented", language),
			);
			return;
		}
		try {
			dcb.log(
				`${misc.createFormattedName(interaction.member as GuildMember)} called command ${chalk.bgGray.whiteBright(interaction.commandName)}`,
			);
			await command.execute({
				interaction,
				client,
				language,
			});
		} catch (e) {
			globalApp.err(e);
			await interaction
				.reply(misc.errorMessageObj(language))
				.catch(async () => {
					await interaction
						.editReply(misc.errorMessageObj(language))
						.catch(async () => {
							await interaction
								.followUp(misc.errorMessageObj(language))
								.catch(() => {
									globalApp.err("Cannot send error message");
								});
						});
				});
		}
	}
});

client.on("shardError", (e) => {
	dcb.log(`Shard Error: ${e}`);
});

event.on("reloadCommands", () => {
	globalApp.important("Reloading commands");
	try {
		commands = loadCommands("slash");
		contextCommands = loadCommands("context");
	} catch (e) {
		globalApp.err(e);
	}
	globalApp.important("Reloaded commands");
});
