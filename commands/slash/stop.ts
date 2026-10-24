import { SlashCommandBuilder } from "discord.js";
import {
	getAudioPlayer,
	getBotVoiceChannel,
	getConnection,
	guildQueues,
} from "../../lib/voice/core";
import { type Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";
import { queueOf, queueOption, respondQueues } from "../../lib/voice/queueOption";

export default {
	data: new SlashCommandBuilder()
		.setName("stop")
		.setDescription("Stop the music playing")
		.addIntegerOption(queueOption("Stop only this queue; every queue if left empty")),
	async autocomplete({ interaction, client, language }) {
		return respondQueues(interaction, client, language);
	},
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
		const queue = queueOf(interaction);
		const player = getAudioPlayer(client, interaction.guild.id, interaction.channel, language, {
			createPlayer: false,
			queue,
		});
		let stopped = false;
		if (queue !== null) {
			stopped = player?.cleanStop({ keepMix: true }) ?? false;
		} else if (player) {
			// Every queue, which stopping queue 1 outright does
			stopped = guildQueues(client, interaction.guild.id).some(
				(each) => each.isPlaying || each.wait !== null,
			);
			player.cleanStop();
		}
		if (stopped) {
			return interaction.reply({
				content: languageText("stop", language),
			});
		}
		interaction.reply({
			content: languageText("not_playing", language),
		});
	},
} as Command<SlashCommandBuilder>;
