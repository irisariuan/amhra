import { SlashCommandBuilder } from "discord.js";
import {
	getAudioPlayer,
	getBotVoiceChannel,
	getConnection,
} from "../../lib/voice/core";
import type { Command } from "../../lib/interaction";

export default {
	data: new SlashCommandBuilder()
		.setName("skip")
		.setDescription("Skip the song")
		.addIntegerOption((option) =>
			option
				.setName("amount")
				.setDescription("The number of songs to skip")
				.setRequired(false)
				.setMinValue(1),
		),
	async execute(interaction, client) {
		if (!interaction.guild)
			return await interaction.reply({
				content: "This command can only be used in a server.",
			});
		if (
			!interaction.member ||
			!("voice" in interaction.member) ||
			!interaction.member.voice.channel
		)
			return await interaction.reply({
				content: "You are not in a voice channel",
			});
		const botVoiceChannel = getBotVoiceChannel(interaction.guild, client);
		const connection = getConnection(interaction.guild.id);
		if (
			botVoiceChannel &&
			connection &&
			interaction.member.voice.channel.id !== botVoiceChannel.id
		) {
			return await interaction.reply({
				content: "You are not in the same voice channel as me",
			});
		}
		const amount = interaction.options.getInteger("amount") ?? 1;
		const player = getAudioPlayer(
			client,
			interaction.guild.id,
			interaction.channel,
			{ createPlayer: false },
		);
		if (!player || !player.isPlaying)
			return await interaction.reply("I'm not playing anything");
		player.stop();
		const queueSize = player.queue.length;
		if (amount > 1) {
			player.queue.splice(0, amount - 1);
		}
		interaction.reply({
			content: `Skipped ${Math.min(queueSize + 1, amount)} song(s)`,
		});
	},
} as Command<SlashCommandBuilder>;
