import { type Command } from "../../lib/interaction";
import { SlashCommandBuilder } from "discord.js";
import {
	getAudioPlayer,
	getBotVoiceChannel,
	getConnection,
} from "../../lib/voice/core";
import { dcb } from "../../lib/misc";
import { languageText } from "../../lib/language";

export default {
	data: new SlashCommandBuilder()
		.setName("pause")
		.setDescription("Pause the music playing"),
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
			{
				createPlayer: false,
			},
		);
		if (!player)
			return await interaction.reply({
				content: languageText("not_playing", language),
			});
		if (player.pause()) {
			dcb.log(`(Guild ID: ${player.guildId}) Paused the music`);
			await interaction.reply({
				content: languageText("paused", language),
			});
		} else {
			await interaction.reply({
				content: languageText("failed_pause", language),
			});
		}
	},
} as Command<SlashCommandBuilder>;
