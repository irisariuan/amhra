import chalk from "chalk";
import {
    type ContextMenuCommandBuilder,
    GatewayIntentBits,
    type GuildMember,
    type SlashCommandBuilder,
} from "discord.js";
import { loadCommands } from "./core";
import { CustomClient } from "./custom";
import { event } from "./express/event";
import { dcb, globalApp, misc } from "./misc";
import { readSetting } from "./setting";

const setting = readSetting();
export const client = new CustomClient({
	intents: [
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.Guilds,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildMessageReactions,
		GatewayIntentBits.GuildMessageTyping,
	],
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
	if (interaction.isUserContextMenuCommand()) {
		const command = contextCommands.get(interaction.commandName);
		if (!command) {
			globalApp.important(
				`Command not implemented: ${interaction.commandName}`,
			);
			interaction.reply("Command not implemented!");
			return;
		}
		try {
			dcb.log(
				`${misc.createFormattedName((interaction.targetMember || interaction.targetUser || interaction.member) as GuildMember)} called context command ${chalk.bgGray.whiteBright(interaction.commandName)}`,
			);
			await command.execute(interaction, client);
		} catch (e) {
			globalApp.err(e);
			try {
				await interaction.reply(misc.errorMessage);
			} catch {
				globalApp.err("Cannot send error message");
			}
		}
	}
	if (interaction.isChatInputCommand()) {
		const command = commands.get(interaction.commandName);
		if (!command) {
			globalApp.important(
				`Command not implemented: ${interaction.commandName}`,
			);
			interaction.reply("Command not implemented!");
			return;
		}
		try {
			dcb.log(
				`${misc.createFormattedName(interaction.member as GuildMember)} called command ${chalk.bgGray.whiteBright(interaction.commandName)}`,
			);
			await command.execute(interaction, client);
		} catch (e) {
			globalApp.err(e);
			try {
				await interaction.reply(misc.errorMessage);
			} catch {
				globalApp.err("Cannot send error message");
			}
		}
	}
});

client.on("messageCreate", async (message) => {
	if (message.author.id === client.user?.id || !setting.MESSAGE_LOGGING)
		return;
	dcb.messageLog(
		`${message.author.tag} (Guild ID: ${message.guildId}, Channel ID: ${message.channelId}, Message ID: ${message.id}): '${chalk.bgWhite.black(message.content)}'${Array.from(message.attachments.values()).length ? `Attachments: ${message.attachments.map((v) => `URL: ${v.url}, Type: ${v.contentType}`).join(", ")}` : ""}`,
	);
	if (message.content.startsWith(setting.PREFIX)) {
		const args = message.content.slice(setting.PREFIX.length).split(" ");
		switch (args.shift()) {
			default:
				return;
			// todo
		}
	}
});

client.on("messageDelete", (message) => {
	if (message.author?.id === client.user?.id || !setting.MESSAGE_LOGGING)
		return;
	dcb.messageLog(
		`${chalk.red("[DELETE]")} ${message.author?.tag} (Guild ID: ${message.guildId}, Channel ID: ${message.channelId}, Message ID: ${message.id}) deleted '${chalk.bgWhite.black(message.content)}''${message.attachments ? `Attachments: ${message.attachments.map((v) => `URL: ${v.url}, Type: ${v.contentType}`).join(", ")}` : ""}`,
	);
});

client.on("messageUpdate", (oldMessage, newMessage) => {
	if (oldMessage.author?.id === client.user?.id || !setting.MESSAGE_LOGGING)
		return;
	if (oldMessage.content === newMessage.content) {
		return;
	}
	dcb.messageLog(
		`${chalk.yellowBright("[EDIT]")} ${newMessage.author?.tag} (Guild ID: ${newMessage.guildId}, Channel ID: ${newMessage.channelId}, Message ID: ${newMessage.id === oldMessage.id ? newMessage.id : `N${newMessage.id}O${oldMessage.id}`}) edited '${chalk.bgWhite.black(oldMessage.content)}' to '${chalk.bgWhite.black(newMessage.content)}'`,
	);
});

client.on("voiceStateUpdate", (oldState, newState) => {
	if (!setting.VOICE_LOGGING) return;
	const formatter = misc.prefixFormatter(
		`${chalk.bgMagentaBright("[VOICE]")} (Channel ID: ${newState.channelId ?? oldState.channelId}, Guild ID: ${newState.guild.id})`,
	);
	if (!newState.member) {
		return dcb.log(formatter("Member not found"));
	}
	const formattedName = misc.createFormattedName(newState.member);

	if (oldState.channel !== newState.channel) {
		dcb.log(
			formatter(
				`${formattedName} ${newState.channel ? "joined" : "left"} voice channel`,
			),
		);
	}
	if (oldState.deaf !== newState.deaf) {
		dcb.log(
			formatter(
				`${formattedName} is now ${newState.deaf ? "deafening" : "hearing"}`,
			),
		);
	}
	if (oldState.mute !== newState.mute) {
		dcb.log(
			formatter(
				`${formattedName} is now ${newState.mute ? "muting" : "unmuted"}`,
			),
		);
	}
	if (oldState.selfVideo !== newState.selfVideo) {
		dcb.log(
			formatter(
				`${formattedName} ${newState.selfVideo ? "is now streaming" : "just stopped streaming"}`,
			),
		);
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
