import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type MessageActionRowComponentBuilder,
	StringSelectMenuBuilder,
} from "discord.js";
import type { Language } from "../interaction";
import { languageText } from "../language";
import { VOICE_LANGUAGES, type VoiceLanguage } from "./voiceSetting";

/**
 * The message /voicelanguage answers with, where someone puts the languages they
 * speak in order and chooses the one they are answered in. Kept apart from the
 * command, and from anything that saves or sends, so what each click does and
 * what Discord is sent can be tested on their own.
 */

/** What someone has chosen. */
export type LanguageChoice = { speaks: VoiceLanguage[]; answers?: VoiceLanguage };

const ADD = "voice-language-add";
const UP = "voice-language-up:";
const REMOVE = "voice-language-remove:";
const OUTPUT = "voice-language-output";
const CLEAR = "voice-language-clear";
export const DONE = "voice-language-done";
/** The output choice meaning the language heard: no choice at all. */
const HEARD = "heard";

const isLanguage = (value: string | undefined): value is VoiceLanguage =>
	value !== undefined && value in VOICE_LANGUAGES;

/** What `choice` becomes when `customId` is used, with what was picked in it. */
export function afterClick(choice: LanguageChoice, customId: string, values: string[] = []): LanguageChoice {
	const { speaks } = choice;
	const picked = values[0];
	if (customId === ADD) {
		return isLanguage(picked) && !speaks.includes(picked) ? { ...choice, speaks: [...speaks, picked] } : choice;
	}
	if (customId === OUTPUT) return { ...choice, answers: isLanguage(picked) ? picked : undefined };
	if (customId === CLEAR) return { ...choice, speaks: [] };
	if (customId.startsWith(REMOVE)) {
		return { ...choice, speaks: speaks.filter((language) => language !== customId.slice(REMOVE.length)) };
	}
	if (customId.startsWith(UP)) {
		const at = speaks.findIndex((language) => language === customId.slice(UP.length));
		const above = speaks[at - 1];
		const moved = speaks[at];
		if (above === undefined || moved === undefined) return choice;
		return { ...choice, speaks: speaks.with(at - 1, moved).with(at, above) };
	}
	return choice;
}

/** What they have chosen, in words. */
export function panelContent({ speaks, answers }: LanguageChoice, language: Language, takesLanguage: boolean) {
	const named = speaks.map((spoken) => VOICE_LANGUAGES[spoken]).join(" > ");
	const input = speaks.length
		? languageText(takesLanguage ? "voice_language_input" : "voice_language_input_guesses", language, {
				language: named,
			})
		: languageText("voice_language_input_auto", language);
	const output = answers
		? languageText("voice_language_output", language, { language: VOICE_LANGUAGES[answers] })
		: languageText("voice_language_output_auto", language);
	return `${input}\n${output}`;
}

const row = (...components: MessageActionRowComponentBuilder[]) =>
	new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...components);

const button = (customId: string, label: string, style = ButtonStyle.Secondary) =>
	new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);

/** What to click. A row with nothing in it is left out: Discord refuses one. */
export function panelComponents({ speaks, answers }: LanguageChoice, language: Language) {
	const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
	const all = Object.entries(VOICE_LANGUAGES) as [VoiceLanguage, string][];
	const unlisted = all.filter(([code]) => !speaks.includes(code));
	if (unlisted.length) {
		rows.push(
			row(
				new StringSelectMenuBuilder()
					.setCustomId(ADD)
					.setPlaceholder(languageText("voice_language_add", language))
					.addOptions(unlisted.map(([value, label]) => ({ label, value }))),
			),
		);
	}
	// The first has nowhere to go.
	if (speaks.length > 1) {
		rows.push(row(...speaks.slice(1).map((code) => button(`${UP}${code}`, `↑ ${VOICE_LANGUAGES[code]}`))));
	}
	if (speaks.length) {
		rows.push(row(...speaks.map((code) => button(`${REMOVE}${code}`, `✕ ${VOICE_LANGUAGES[code]}`))));
	}
	rows.push(
		row(
			new StringSelectMenuBuilder()
				.setCustomId(OUTPUT)
				.setPlaceholder(languageText("voice_language_output_pick", language))
				.addOptions(
					{
						label: languageText("voice_language_output_heard", language),
						value: HEARD,
						default: answers === undefined,
					},
					...all.map(([value, label]) => ({ label, value, default: answers === value })),
				),
		),
	);
	const last = [button(DONE, languageText("voice_language_done", language), ButtonStyle.Primary)];
	if (speaks.length) last.unshift(button(CLEAR, languageText("voice_language_clear", language)));
	rows.push(row(...last));
	return rows;
}
