import { SlashCommandBuilder } from "discord.js";
import { getAudioPlayer, getBotVoiceChannel } from "../../lib/voice/core";
import type { Command } from "../../lib/interaction";

export default {
	data: new SlashCommandBuilder()
		.setName("skip")
		.setDescription("Skip the song"),
	async execute(interaction, client) {
		if (!interaction.guild)
			return await interaction.reply({
				content: "This command can only be used in a server.",
			});
		if (!interaction.member || !('voice' in interaction.member) || !interaction.member.voice.channel) return await interaction.reply({
			content: "You are not in a voice channel",
		});
		const botVoiceChannel = getBotVoiceChannel(interaction.guild, client)
		if (botVoiceChannel && interaction.member.voice.channel.id !== botVoiceChannel.id) {
			return await interaction.reply({
				content: "You are not in the same voice channel as me",
			});
		}
		const player = getAudioPlayer(
			client,
			interaction.guild.id,
			interaction.channel,
			{ createPlayer: false },
		);
		if (!player) return await interaction.reply("I'm not playing anything");
		player.stop();
		interaction.reply({ content: "Skipped!" });
	},
} as Command<SlashCommandBuilder>;
