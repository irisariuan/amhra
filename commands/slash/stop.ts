import { SlashCommandBuilder } from "discord.js";
import {
	getAudioPlayer,
	getBotVoiceChannel,
	getConnection,
} from "../../lib/voice/core";
import { type Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";

export default {
	data: new SlashCommandBuilder()
		.setName("stop")
		.setDescription("Stop the music playing"),
	async execute({ interaction, client, language }) {
		if (!interaction.guild)
			return await interaction.reply({
				content: languageText("server_only_command", language),
			});
		if (
			!interaction.member ||
			!("voice" in interaction.member) ||
			!interaction.member.voice.channel
		)
			return await interaction.reply({
				content: languageText("user_not_in_voice", language),
			});
		const botVoiceChannel = getBotVoiceChannel(interaction.guild, client);
		const connection = getConnection(interaction.guild.id);
		if (
			botVoiceChannel &&
			connection &&
			interaction.member.voice.channel.id !== botVoiceChannel.id
		) {
			return await interaction.reply({
				content: languageText("not_same_voice", language),
			});
		}
		const player = getAudioPlayer(
			client,
			interaction.guild.id,
			interaction.channel,
			language,
		);
		if (player?.cleanStop()) {
			return interaction.reply({
				content: languageText("stop", language),
			});
		}
		interaction.reply({
			content: languageText("not_playing", language),
		});
	},
} as Command<SlashCommandBuilder>;
