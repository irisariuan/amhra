import { SlashCommandBuilder } from "discord.js";
import {
	getAudioPlayer,
	getBotVoiceChannel,
	getConnection,
	timeFormat,
} from "../../lib/voice/core";
import { type Command } from "../../lib/interaction";

export default {
	data: new SlashCommandBuilder()
		.setName("skipnonmusic")
		.setDescription("Skip current non-music part"),
	async execute({ interaction, client }) {
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
		const player = getAudioPlayer(
			client,
			interaction.guild.id,
			interaction.channel,
			{
				createPlayer: false,
			},
		);
		if (!player || !player.isPlaying)
			return await interaction.reply("I'm not playing anything");
		const currentSegment = player.currentSegment();
		if (!currentSegment) {
			return await interaction.reply({
				content: "I'm not playing any non-music part",
			});
		}
		const result = await player.skipCurrentSegment();
		if (result.success) {
			await interaction.reply({
				content: `Skipped to \`${result.skipped ? "next song" : timeFormat(currentSegment.segment[1])}\``,
			});
		} else {
			await interaction.reply({
				content: "Failed to skip the current non-music part",
			});
		}
	},
} as Command<SlashCommandBuilder>;
