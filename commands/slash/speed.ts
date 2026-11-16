import { SlashCommandBuilder } from "discord.js";
import {
	getAudioPlayer,
	getBotVoiceChannel,
	getConnection,
} from "../../lib/voice/core";
import { type Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";
import { nativeVoiceActive } from "../../lib/voice/native";
import { MAX_SPEED, MIN_SPEED } from "../../lib/voice/nativePlan";
import { queueOf, queueOption, respondQueues } from "../../lib/voice/queueOption";

export default {
	data: new SlashCommandBuilder()
		.setName("speed")
		.setDescription("Set how fast songs play, keeping their pitch")
		.addNumberOption((opt) =>
			opt
				.setName("speed")
				.setDescription("0 to 10 in steps of 0.01; 1 is normal and 0 holds the song silent")
				.setMinValue(MIN_SPEED)
				.setMaxValue(MAX_SPEED)
				.setRequired(true),
		)
		.addIntegerOption(queueOption("Only this queue's speed; queue 1's if left empty")),
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
		// Only the sidecar can stretch audio
		if (!nativeVoiceActive())
			return interaction.reply({
				content: languageText("speed_native_only", language),
			});
		if (!connection)
			return interaction.reply({
				content: languageText("not_connected", language),
			});
		const queue = queueOf(interaction);
		const player = getAudioPlayer(
			client,
			interaction.guild.id,
			interaction.channel,
			language,
			{ createPlayer: false, queue },
		);
		if (!player)
			return interaction.reply({
				content: languageText("not_playing", language),
			});
		player.setSpeed(interaction.options.getNumber("speed", true));
		const speed = player.speed;
		const key =
			speed === 0
				? "set_speed_zero"
				: queue === null || queue === 1
					? "set_speed"
					: "set_queue_speed";
		return interaction.reply({
			content: languageText(key, language, { speed, queue: queue ?? 1 }),
		});
	},
} as Command<SlashCommandBuilder>;
