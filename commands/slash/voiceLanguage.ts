import { MessageFlags, type SlashCommandStringOption, SlashCommandBuilder } from "discord.js";
import { type Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";
import { setUserSetting, userSetting } from "../../lib/userSetting";
import { sidecar } from "../../lib/voice/sidecar";
import {
	pinnedLanguage,
	rankedLanguages,
	recogniserTakesLanguage,
	VOICE_LANGUAGES,
} from "../../lib/voice/voiceSetting";

const AUTO = "auto";
const LANGUAGE_CHOICES = Object.entries(VOICE_LANGUAGES).map(([value, name]) => ({ name, value }));
const RANKS = ["first", "second", "third", "fourth", "fifth"];

const rank = (name: string, description: string) => (option: SlashCommandStringOption) =>
	option.setName(name).setDescription(description).addChoices(...LANGUAGE_CHOICES);

export default {
	data: new SlashCommandBuilder()
		.setName("voicelanguage")
		.setDescription("Order the languages you speak, and choose the one I answer you in")
		.addStringOption((option) =>
			rank("first", "The language you're most likely to speak; Automatic to have me guess")(option).addChoices({
				name: "Automatic",
				value: AUTO,
			}),
		)
		.addStringOption(rank("second", "The next most likely"))
		.addStringOption(rank("third", "The next most likely"))
		.addStringOption(rank("fourth", "The next most likely"))
		.addStringOption(rank("fifth", "The least likely"))
		.addStringOption((option) =>
			option
				.setName("output")
				.setDescription("The language I answer you in; Chinese is separate for Mandarin and Cantonese")
				.addChoices({ name: "The language I heard", value: AUTO }, ...LANGUAGE_CHOICES),
		),
	async execute({ interaction, language }) {
		// Anyone's own choice, about their own voice, wherever they are. Any rank
		// given replaces the whole order. With nothing given this only says what
		// they are.
		const userId = interaction.user.id;
		const ranks = RANKS.map((name) => interaction.options.getString(name));
		const output = interaction.options.getString("output");
		if (ranks.some((choice) => choice !== null)) {
			const voiceLanguages = rankedLanguages(ranks, AUTO);
			setUserSetting(userId, { voiceLanguages });
			sidecar().send({ type: "setMemberLanguage", userId, language: pinnedLanguage(voiceLanguages) });
		}
		if (output !== null) {
			setUserSetting(userId, {
				voiceOutputLanguage: output === AUTO ? undefined : rankedLanguages([output], AUTO)[0],
			});
		}

		const { voiceLanguages: speaks = [], voiceOutputLanguage: answers } = userSetting(userId);
		const named = speaks.map((spoken) => VOICE_LANGUAGES[spoken]).join(" > ");
		const inputLine = speaks.length
			? languageText(recogniserTakesLanguage() ? "voice_language_input" : "voice_language_input_guesses", language, {
					language: named,
				})
			: languageText("voice_language_input_auto", language);
		const outputLine = answers
			? languageText("voice_language_output", language, { language: VOICE_LANGUAGES[answers] })
			: languageText("voice_language_output_auto", language);
		await interaction.reply({ content: `${inputLine}\n${outputLine}`, flags: MessageFlags.Ephemeral });
	},
} as Command<SlashCommandBuilder>;
