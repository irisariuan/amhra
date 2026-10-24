import { SlashCommandBuilder } from "discord.js";
import {
	getAudioPlayer,
	getBotVoiceChannel,
	getConnection,
} from "../../lib/voice/core";
import { type Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";
import { queueOf, queueOption, respondQueues } from "../../lib/voice/queueOption";

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
		)
		.addIntegerOption(queueOption("Set only this queue's own volume; the whole bot's if left empty")),
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
		const volume = interaction.options.getNumber("volume", true);
		const player = getAudioPlayer(
			client,
			interaction.guild.id,
			interaction.channel,
			language,
			{ createPlayer: false, queue: queueOf(interaction) },
		);
		if (!getConnection(interaction.guildId))
			return interaction.reply({
				content: languageText("not_connected", language),
			});
		if (!player)
			return interaction.reply({
				content: languageText("not_playing", language),
			});
		const queue = queueOf(interaction);
		// Left empty, the whole bot's: queue 1's volume, which every queue
		// plays under. Named, that queue's own level under it.
		if (queue === null) player.setVolume(volume / 100);
		else if (queue === 1) player.setMainVolume(volume);
		else player.setVolume(volume / 100);
		interaction.reply({
			content:
				queue === null
					? languageText("set_volume", language, { volume })
					: languageText("set_queue_volume", language, { volume, queue }),
		});
	},
} as Command<SlashCommandBuilder>;
