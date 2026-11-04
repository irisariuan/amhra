import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { type Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";
import { setUserSetting } from "../../lib/userSetting";
import { sidecar } from "../../lib/voice/sidecar";
import { recogniserTakesLanguage, VOICE_LANGUAGES, type VoiceLanguage } from "../../lib/voice/voiceSetting";

const AUTO = "auto";

export default {
	data: new SlashCommandBuilder()
		.setName("voicelanguage")
		.setDescription("Choose the language I hear you in, and answer you in")
		.addStringOption((option) =>
			option
				.setName("language")
				.setDescription("Your language; Chinese is separate for Mandarin and Cantonese")
				.setRequired(true)
				.addChoices(
					{ name: "Automatic", value: AUTO },
					...Object.entries(VOICE_LANGUAGES).map(([value, name]) => ({ name, value })),
				),
		),
	async execute({ interaction, language }) {
		// Anyone's own choice, about their own voice, wherever they are.
		const choice = interaction.options.getString("language", true);
		const chosen = choice === AUTO ? undefined : (choice as VoiceLanguage);
		setUserSetting(interaction.user.id, { voiceLanguage: chosen });
		sidecar().send({ type: "setMemberLanguage", userId: interaction.user.id, language: chosen ?? null });
		const id = !chosen ? "voice_language_auto" : recogniserTakesLanguage() ? "voice_language_set" : "voice_language_answers_only";
		await interaction.reply({
			content: languageText(id, language, chosen ? { language: VOICE_LANGUAGES[chosen] } : undefined),
			flags: MessageFlags.Ephemeral,
		});
	},
} as Command<SlashCommandBuilder>;
