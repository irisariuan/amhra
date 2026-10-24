import {
	InteractionContextType,
	PermissionFlagsBits,
	SlashCommandBuilder,
} from "discord.js";
import { type Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";
import { dcb } from "../../lib/misc";
import { guildSetting, setGuildSetting } from "../../lib/guildSetting";

export default {
	data: new SlashCommandBuilder()
		.setName("autojoin")
		.setDescription("Join a voice channel when someone joins one, if not in another")
		.addBooleanOption((option) =>
			option
				.setName("enabled")
				.setDescription("Follow members into voice channels")
				.setRequired(true),
		)
		// Where the bot turns up is the server's call, not any one member's.
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setContexts(InteractionContextType.Guild),
	async execute({ interaction, language }) {
		if (!interaction.guild)
			return await interaction.reply({
				content: languageText("server_only_command", language),
			});

		const enabled = interaction.options.getBoolean("enabled", true);
		if ((guildSetting(interaction.guild.id).autoJoin ?? false) === enabled) {
			return await interaction.reply({
				content: languageText(
					enabled ? "auto_join_already_on" : "auto_join_already_off",
					language,
				),
			});
		}
		setGuildSetting(interaction.guild.id, { autoJoin: enabled });
		dcb.log(
			`(Guild ID: ${interaction.guild.id}) Auto-join turned ${enabled ? "on" : "off"}`,
		);
		await interaction.reply({
			content: languageText(enabled ? "auto_join_on" : "auto_join_off", language),
		});
	},
} as Command<SlashCommandBuilder>;
