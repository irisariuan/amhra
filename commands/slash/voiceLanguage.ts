import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { type Command } from "../../lib/interaction";
import { setUserSetting, userSetting } from "../../lib/userSetting";
import { sidecar } from "../../lib/voice/sidecar";
import {
	afterClick,
	DONE,
	type LanguageChoice,
	panelComponents,
	panelContent,
} from "../../lib/voice/voiceLanguagePanel";
import { pinnedLanguage, recogniserTakesLanguage } from "../../lib/voice/voiceSetting";

/** How long the panel stays usable after its last click. */
const PANEL_IDLE_MS = 5 * 60 * 1000;

export default {
	data: new SlashCommandBuilder()
		.setName("voicelanguage")
		.setDescription("Choose the languages you speak, in order, and the one I answer you in"),
	async execute({ interaction, language }) {
		// Anyone's own choice, about their own voice, wherever they are. Read
		// afresh for each click, so a second panel left open does not undo a first.
		const userId = interaction.user.id;
		const choice = (): LanguageChoice => {
			const { voiceLanguages, voiceOutputLanguage } = userSetting(userId);
			return { speaks: voiceLanguages ?? [], answers: voiceOutputLanguage };
		};
		const panel = (current: LanguageChoice) => ({
			content: panelContent(current, language, recogniserTakesLanguage()),
			components: panelComponents(current, language),
		});

		const response = await interaction.reply({
			...panel(choice()),
			flags: MessageFlags.Ephemeral,
			withResponse: true,
		});
		const collector = response.resource?.message?.createMessageComponentCollector({
			idle: PANEL_IDLE_MS,
			filter: (component) => component.user.id === userId,
		});
		collector?.on("collect", async (component) => {
			if (component.customId === DONE) {
				collector.stop("done");
				await component.update({ content: panelContent(choice(), language, recogniserTakesLanguage()), components: [] });
				return;
			}
			const before = choice();
			const after = afterClick(before, component.customId, component.isStringSelectMenu() ? component.values : []);
			setUserSetting(userId, { voiceLanguages: after.speaks, voiceOutputLanguage: after.answers });
			if (pinnedLanguage(after.speaks) !== pinnedLanguage(before.speaks)) {
				sidecar().send({ type: "setMemberLanguage", userId, language: pinnedLanguage(after.speaks) });
			}
			await component.update(panel(after));
		});
		// Left as it stands, but no longer offering clicks that would do nothing.
		collector?.on("end", (_collected, reason) => {
			if (reason !== "done") interaction.editReply({ components: [] }).catch(() => {});
		});
	},
} as Command<SlashCommandBuilder>;
