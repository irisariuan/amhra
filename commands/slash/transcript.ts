import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { type Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";
import { setUserSetting } from "../../lib/userSetting";

export default {
	data: new SlashCommandBuilder()
		.setName("transcript")
		.setDescription("Show what I hear after you say my name, every time")
		.addBooleanOption((option) =>
			option
				.setName("enabled")
				.setDescription("Post your words in the channel when you say my name")
				.setRequired(true),
		),
	async execute({ interaction, language }) {
		// Anyone's own choice, about their own words, wherever they are.
		const enabled = interaction.options.getBoolean("enabled", true);
		setUserSetting(interaction.user.id, { showTranscript: enabled });
		await interaction.reply({
			content: languageText(enabled ? "transcript_on" : "transcript_off", language),
			flags: MessageFlags.Ephemeral,
		});
	},
} as Command<SlashCommandBuilder>;
