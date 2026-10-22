import {
	InteractionContextType,
	PermissionFlagsBits,
	SlashCommandBuilder,
} from "discord.js";
import { type Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";
import { dcb } from "../../lib/misc";
import { guildSetting, setGuildSetting } from "../../lib/guildSetting";
import { nativeVoiceActive } from "../../lib/voice/native";
import { applyGuildListening } from "../../lib/voice/voiceCommands";
import { voiceCommandsAllowed } from "../../lib/voice/voiceSetting";

export default {
	data: new SlashCommandBuilder()
		.setName("voicecommands")
		.setDescription("Turn listening for my name in voice channels on or off")
		.addBooleanOption((option) =>
			option
				.setName("enabled")
				.setDescription('Listen for "Amhra" and act on what follows')
				.setRequired(true),
		)
		// Whether a bot listens in a server's calls is the server's call, not
		// any one member's.
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setContexts(InteractionContextType.Guild),
	async execute({ interaction, language }) {
		if (!interaction.guild)
			return await interaction.reply({
				content: languageText("server_only_command", language),
			});
		if (!voiceCommandsAllowed() || !nativeVoiceActive())
			return await interaction.reply({
				content: languageText("voice_commands_unavailable", language),
			});

		const enabled = interaction.options.getBoolean("enabled", true);
		if ((guildSetting(interaction.guild.id).voiceCommands ?? false) === enabled) {
			return await interaction.reply({
				content: languageText(
					enabled ? "voice_commands_already_on" : "voice_commands_already_off",
					language,
				),
			});
		}
		setGuildSetting(interaction.guild.id, { voiceCommands: enabled });
		dcb.log(
			`(Guild ID: ${interaction.guild.id}) Voice commands turned ${enabled ? "on" : "off"}`,
		);
		await interaction.reply({
			content: languageText(
				enabled ? "voice_commands_on" : "voice_commands_off",
				language,
			),
		});
		applyGuildListening(interaction.guild, enabled);
	},
} as Command<SlashCommandBuilder>;
