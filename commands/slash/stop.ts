import { SlashCommandBuilder } from "discord.js";
import {
	getAudioPlayer,
	getBotVoiceChannel,
	getConnection,
} from "../../lib/voice/core";
import { type Command } from "../../lib/interaction";

export default {
	data: new SlashCommandBuilder()
		.setName("stop")
		.setDescription("Stop the music playing"),
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
		);
		if (player?.cleanStop()) {
			return interaction.reply({
				content: "Stopped the music",
			});
		}
		interaction.reply({
			content: "Not playing music",
		});
	},
} as Command<SlashCommandBuilder>;
