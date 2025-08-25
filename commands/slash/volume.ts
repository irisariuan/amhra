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
		const volume = interaction.options.getNumber("volume", true);
		const player = getAudioPlayer(
			client,
			interaction.guild.id,
			interaction.channel,
			language,
			{ createPlayer: false },
		);
		if (!getConnection(interaction.guildId))
			return interaction.reply({
				content: languageText("not_connected", language),
			});
		if (!player)
			return interaction.reply({
				content: languageText("not_playing", language),
			});
		player.setVolume(volume / 100);
		interaction.reply({
			content: languageText("set_volume", language, { volume }),
		});
	},
} as Command<SlashCommandBuilder>;
