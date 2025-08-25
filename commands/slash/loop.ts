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
		.setName("loop")
		.setDescription(
			"Toggle the loop mode or set the loop mode to a specific type",
		)
		.addBooleanOption((option) =>
			option
				.setName("enabled")
				.setDescription("Enable or disable the loop mode")
				.setRequired(false),
		),
	async execute({ interaction, client, language }) {
		const setLoop = interaction.options.getBoolean("enabled");
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
		if (setLoop === null) {
			return await interaction.reply({
				content: languageText(
					player.toggleLoop()
						? "toggle_loop_true"
						: "toggle_loop_false",
					language,
				),
			});
		}
		if (setLoop === player.looping) {
			return await interaction.reply({
				content: languageText(
					setLoop ? "loop_already_true" : "loop_already_false",
					language,
				),
			});
		}
		if (setLoop) {
			player.enableLoop();
			return await interaction.reply({
				content: languageText("set_loop_true", language),
			});
		}
		player.disableLoop();
		return await interaction.reply({
			content: languageText("set_loop_false", language),
		});
	},
} as Command<SlashCommandBuilder>;
