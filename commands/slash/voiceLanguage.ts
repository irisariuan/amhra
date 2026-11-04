import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { type Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";
import { setUserSetting, userSetting } from "../../lib/userSetting";
import { sidecar } from "../../lib/voice/sidecar";
import { recogniserTakesLanguage, VOICE_LANGUAGES, type VoiceLanguage } from "../../lib/voice/voiceSetting";

const AUTO = "auto";
const LANGUAGE_CHOICES = Object.entries(VOICE_LANGUAGES).map(([value, name]) => ({ name, value }));

/** A choice as it is kept: automatic is no choice at all. */
const chosen = (choice: string) => (choice === AUTO ? undefined : (choice as VoiceLanguage));

export default {
	data: new SlashCommandBuilder()
		.setName("voicelanguage")
		.setDescription("Choose the language I hear you in, and the one I answer you in")
		.addStringOption((option) =>
			option
				.setName("input")
				.setDescription("The language you speak; Chinese is separate for Mandarin and Cantonese")
				.addChoices({ name: "Automatic", value: AUTO }, ...LANGUAGE_CHOICES),
		)
		.addStringOption((option) =>
			option
				.setName("output")
				.setDescription("The language I answer you in; Chinese is separate for Mandarin and Cantonese")
				.addChoices({ name: "The language I heard", value: AUTO }, ...LANGUAGE_CHOICES),
		),
	async execute({ interaction, language }) {
		// Anyone's own choice, about their own voice, wherever they are. Each
		// left out stays as it is, so with neither this only says what they are.
		const userId = interaction.user.id;
		const input = interaction.options.getString("input");
		const output = interaction.options.getString("output");
		if (input !== null) {
			setUserSetting(userId, { voiceInputLanguage: chosen(input) });
			sidecar().send({ type: "setMemberLanguage", userId, language: chosen(input) ?? null });
		}
		if (output !== null) setUserSetting(userId, { voiceOutputLanguage: chosen(output) });

		const { voiceInputLanguage: hears, voiceOutputLanguage: answers } = userSetting(userId);
		const inputLine = hears
			? languageText(recogniserTakesLanguage() ? "voice_language_input" : "voice_language_input_guesses", language, {
					language: VOICE_LANGUAGES[hears],
				})
			: languageText("voice_language_input_auto", language);
		const outputLine = answers
			? languageText("voice_language_output", language, { language: VOICE_LANGUAGES[answers] })
			: languageText("voice_language_output_auto", language);
		await interaction.reply({ content: `${inputLine}\n${outputLine}`, flags: MessageFlags.Ephemeral });
	},
} as Command<SlashCommandBuilder>;
