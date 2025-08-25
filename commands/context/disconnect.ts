import { ContextMenuCommandBuilder, ApplicationCommandType } from "discord.js";
import {
	destroyAudioPlayer,
	disconnectConnection,
	getConnection,
} from "../../lib/voice/core";
import { dcb } from "../../lib/misc";
import type { Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";

export default {
	data: new ContextMenuCommandBuilder()
		.setName("disconnect")
		.setType(ApplicationCommandType.User),
	execute({ interaction, client, language }) {
		const connection = getConnection(interaction.guildId);
		if (connection) {
			disconnectConnection(connection);
			dcb.log("Disconnected");
			interaction.reply({
				content: languageText("disconnected", language),
			});
			if (!interaction.guildId) return;
			//also destroy the audio player if there is one
			destroyAudioPlayer(client, interaction.guildId);
		} else {
			interaction.reply({
				content: languageText("not_connected", language),
			});
		}
	},
} as Command<ContextMenuCommandBuilder>;
