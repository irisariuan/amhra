import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { type Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";
import { setUserSetting } from "../../lib/userSetting";

export default {
	data: new SlashCommandBuilder()
		.setName("voicefeedback")
		.setDescription("Hear me say what I'm doing when you give a voice command")
		.addBooleanOption((option) =>
			option
				.setName("enabled")
				.setDescription("Say aloud what your voice commands do")
				.setRequired(true),
		),
	async execute({ interaction, language }) {
		// Anyone's own choice, for their own commands, wherever they are.
		const enabled = interaction.options.getBoolean("enabled", true);
		setUserSetting(interaction.user.id, { spokenAnswers: enabled });
		await interaction.reply({
			content: languageText(enabled ? "voice_feedback_on" : "voice_feedback_off", language),
			flags: MessageFlags.Ephemeral,
		});
	},
} as Command<SlashCommandBuilder>;
