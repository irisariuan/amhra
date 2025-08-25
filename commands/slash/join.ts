import type { Command } from "../../lib/interaction";

import { SlashCommandBuilder } from "discord.js";
import { getVoiceConnection } from "@discordjs/voice";
import { joinVoice, getAudioPlayer } from "../../lib/voice/core";
import { dcb } from "../../lib/misc";
import { misc } from "../../lib/misc";
import { languageText } from "../../lib/language";

export default {
	data: new SlashCommandBuilder()
		.setName("join")
		.setDescription("Join the voice channel"),
	async execute({ interaction, client, language }) {
		if (
			!interaction.guild ||
			!interaction.inGuild() ||
			!("voice" in interaction.member)
		) {
			return interaction.reply(misc.errorMessageObj(language));
		}

		if (!interaction.member.voice.channel) {
			return interaction.reply({
				content: languageText("user_not_in_voice", language),
			});
		}

		const existingPlayer = getAudioPlayer(
			client,
			interaction.guildId,
			null,
			language,
			{ createPlayer: false },
		);
		const existingConnection = getVoiceConnection(interaction.guild.id);
		if (
			existingConnection &&
			existingPlayer &&
			(existingPlayer.isPlaying || existingPlayer.queue.length > 0)
		) {
			return interaction.reply({
				content: languageText("already_connected", language),
			});
		} else if (existingPlayer) {
			existingConnection?.destroy();
			dcb.log("Destroyed existing connection");
			const newConnection = joinVoice(
				interaction.member.voice.channel,
				interaction.guild,
			);
			newConnection.subscribe(existingPlayer);
			dcb.log("Joined voice channel");
			return interaction.reply({
				content: languageText("joined_voice", language),
			});
		}
		dcb.log("Joined voice");
		const connection = joinVoice(
			interaction.member.voice.channel,
			interaction.guild,
		);
		if (!connection) return;

		dcb.log("Created Player");
		const player = getAudioPlayer(
			client,
			interaction.guildId,
			interaction.channel,
			language,
		);
		if (!player) return;
		connection.subscribe(player);

		interaction.reply({
			content: languageText("joined_voice", language),
		});
	},
} as Command<SlashCommandBuilder>;
