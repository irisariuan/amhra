import { type Command } from "../../lib/interaction";
import { SlashCommandBuilder } from "discord.js";
import {
	getBotVoiceChannel,
	getConnection,
	getAudioPlayer,
} from "../../lib/voice/core";
import { languageText } from "../../lib/language";

export default {
	data: new SlashCommandBuilder()
		.setName("autoskipnonmusic")
		.setDescription(
			"Toggle the mode or set the mode to a specific type for auto skipping non-music parts behavior",
		)
		.addBooleanOption((option) =>
			option
				.setName("enabled")
				.setDescription("Enable or disable the loop mode")
				.setRequired(false),
		),
	async execute({ interaction, client, language }) {
		const setSkip = interaction.options.getBoolean("enabled");
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
			{ createPlayer: false },
		);
		if (!player) {
			return await interaction.reply({
				content: languageText("not_playing", language),
			});
		}
		if (setSkip === null) {
			player.customSetting.autoSkipSegment = !(
				player.customSetting.autoSkipSegment ?? false
			);
			return await interaction.reply({
				content: languageText(
					player.customSetting.autoSkipSegment
						? "toggle_auto_skip_true"
						: "toggle_auto_skip_false",
					language,
				),
			});
		}
		if (setSkip === player.customSetting.autoSkipSegment) {
			return await interaction.reply({
				content: languageText(
					setSkip
						? "auto_skip_already_true"
						: "auto_skip_already_false",
					language,
				),
			});
		}
		if (setSkip) {
			player.customSetting.autoSkipSegment = true;
			return await interaction.reply({
				content: languageText("set_auto_skip_true", language),
			});
		}

		player.customSetting.autoSkipSegment = false;
		return await interaction.reply({
			content: languageText("set_auto_skip_false", language),
		});
	},
} as Command<SlashCommandBuilder>;
