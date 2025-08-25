import { SlashCommandBuilder } from "discord.js";
import {
	getAudioPlayer,
	getBotVoiceChannel,
	getConnection,
	timeFormat,
} from "../../lib/voice/core";
import { type Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";

export default {
	data: new SlashCommandBuilder()
		.setName("skipnonmusic")
		.setDescription("Skip current non-music part"),
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
		if (!player || !player.isPlaying)
			return await interaction.reply(
				languageText("not_playing", language),
			);
		const currentSegment = player.currentSegment();
		if (!currentSegment) {
			return await interaction.reply({
				content: languageText("not_playing_non_music", language),
			});
		}
		const result = await player.skipCurrentSegment();
		if (result.success) {
			await interaction.reply({
				content: languageText(
					result.skipped ? "segment_skip_next" : "segment_skip",
					language,
					{
						pos: timeFormat(currentSegment.segment[1]),
					},
				),
			});
		} else {
			await interaction.reply({
				content: languageText("fail_skip_segment", language),
			});
		}
	},
} as Command<SlashCommandBuilder>;
