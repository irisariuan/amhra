import { SlashCommandBuilder } from "discord.js";
import {
	getAudioPlayer,
	getBotVoiceChannel,
	getConnection,
} from "../../lib/voice/core";
import type { Command } from "../../lib/interaction";

export default {
	data: new SlashCommandBuilder()
		.setName("volume")
		.setDescription("Set volume of the bot")
		.addNumberOption((opt) =>
			opt
				.setName("volume")
				.setDescription("Set the volume of the bot")
				.setMinValue(0)
				.setMaxValue(500)
				.setRequired(true),
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
		if (
			botVoiceChannel &&
			interaction.member.voice.channel.id !== botVoiceChannel.id
		) {
			return await interaction.reply({
				content: "You are not in the same voice channel as me",
			});
		}
		const volume = interaction.options.getNumber("volume", true) / 100;
		const player = getAudioPlayer(
			client,
			interaction.guild.id,
			interaction.channel,
			{ createPlayer: false },
		);
		if (!getConnection(interaction.guildId))
			return interaction.reply({
				content: "I'm not in a voice channel!",
			});
		if (!player)
			return interaction.reply({ content: "I'm not playing song!" });
		player.setVolume(volume);
		interaction.reply({ content: `Set the volume to ${volume * 100}%` });
	},
} as Command<SlashCommandBuilder>;
