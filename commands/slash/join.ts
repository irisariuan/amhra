import type { Command } from "../../lib/interaction";

import { SlashCommandBuilder } from "discord.js";
import { getVoiceConnection } from "@discordjs/voice";
import { joinVoice, getAudioPlayer } from "../../lib/voice/core";
import { dcb } from "../../lib/misc";
import { misc } from "../../lib/misc";

export default {
	data: new SlashCommandBuilder()
		.setName("join")
		.setDescription("Join the voice channel"),
	async execute({ interaction, client }) {
		if (
			!interaction.guild ||
			!interaction.inGuild() ||
			!("voice" in interaction.member)
		) {
			return interaction.reply(misc.errorMessageObj);
		}

		if (!interaction.member.voice.channel) {
			return interaction.reply({
				content: "You are not in a voice channel",
			});
		}

		const existingPlayer = getAudioPlayer(
			client,
			interaction.guildId,
			null,
			{ createPlayer: false },
		);
		const existingConnection = getVoiceConnection(interaction.guild.id);
		if (
			existingConnection &&
			existingPlayer &&
			(existingPlayer.isPlaying || existingPlayer.queue.length > 0)
		) {
			return interaction.reply({
				content: "I am already in a voice channel",
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
				content: "Joined voice channel",
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
			{ createPlayer: true },
		);
		if (!player) return;
		connection.subscribe(player);

		interaction.reply({
			content: "Joined voice channel",
		});
	},
} as Command<SlashCommandBuilder>;
