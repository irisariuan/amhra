import { type Command } from "../../lib/interaction";
import { SlashCommandBuilder } from "discord.js";
import {
	getBotVoiceChannel,
	getConnection,
	getAudioPlayer,
} from "../../lib/voice/core";

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
	async execute({ interaction, client }) {
		const setLoop = interaction.options.getBoolean("enabled");
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
			{ createPlayer: false },
		);
		if (!player) {
			return await interaction.reply({
				content: "I am not playing anything",
			});
		}
		if (setLoop === null) {
			return await interaction.reply({
				content: `Loop mode is now ${player.toggleLoop() ? "enabled" : "disabled"}.`,
			});
		}
		if (setLoop === player.looping) {
			return await interaction.reply({
				content: `Loop mode is already ${setLoop ? "enabled" : "disabled"}.`,
			});
		}
		if (setLoop) {
			player.enableLoop();
			return await interaction.reply({
				content: "Loop mode is now enabled.",
			});
		}
		player.disableLoop();
		return await interaction.reply({
			content: "Loop mode is now disabled.",
		});
	},
} as Command<SlashCommandBuilder>;
