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
		.setName("skip")
		.setDescription("Skip the song")
		.addIntegerOption((option) =>
			option
				.setName("amount")
				.setDescription("The number of songs to skip")
				.setRequired(false)
				.setMinValue(1),
		),
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
		const amount = interaction.options.getInteger("amount") ?? 1;
		const player = getAudioPlayer(
			client,
			interaction.guild.id,
			interaction.channel,
			language,
			{ createPlayer: false },
		);
		if (!player || !player.isPlaying)
			return await interaction.reply(
				languageText("not_playing", language),
			);
		player.stop();
		const queueSize = player.queue.length;
		if (amount > 1) {
			player.queue.splice(0, amount - 1);
		}
		interaction.reply({
			content: languageText("skip_song", language, {
				amount: Math.min(queueSize + 1, amount),
			}),
		});
	},
} as Command<SlashCommandBuilder>;
