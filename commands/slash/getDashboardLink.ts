import type { Command } from "../../lib/interaction";
import {
	SlashCommandBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
} from "discord.js";
import { createLink } from "../../lib/dashboard";
import { languageText } from "../../lib/language";
import { ensureAnonymousAccount } from "../../lib/db/account";

export default {
	data: new SlashCommandBuilder()
		.setName("dashboard")
		.setDescription("Online dashboard for controlling song activities"),
	async execute({ interaction, language }) {
		if (!interaction.guildId) return;
		const { token } = await ensureAnonymousAccount(interaction.guildId).catch(
			() => ({ token: null }),
		);
		if (!token) {
			return interaction.reply({
				content: languageText("error", language),
				ephemeral: true,
			});
		}

		const link = await createLink(interaction.guildId, token);
		const linkButton = new ButtonBuilder()
			.setLabel(languageText("dashboard_label", language))
			.setURL(link)
			.setStyle(ButtonStyle.Link);
		const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
			linkButton,
		);
		interaction.reply({ components: [row], ephemeral: true });
	},
} as Command<SlashCommandBuilder>;
