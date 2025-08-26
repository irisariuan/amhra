import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	SlashCommandBuilder,
} from "discord.js";
import { type Command } from "../../lib/interaction";
import { misc } from "../../lib/misc";
import {
	createResource,
	getAudioPlayer,
	getBotVoiceChannel,
	getConnection,
	timeFormat,
} from "../../lib/voice/core";
import {
	cancelThreshold,
	sendInteractionSkipMessage,
	SegmentCategory,
} from "../../lib/voice/segment";
import { languageText } from "../../lib/language";

export default {
	data: new SlashCommandBuilder()
		.setName("relocate")
		.setDescription("Set song to play from the wanted position")
		.addStringOption((opt) =>
			opt
				.setName("position")
				.setDescription(
					"Position to play the song from (in seconds or in HH:MM:SS format)",
				)
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
		const unformattedString = interaction.options.getString(
			"position",
			true,
		);
		if (
			!unformattedString.match(/^\d+$/) &&
			!unformattedString.match(/^(?:(\d{1,}):)?(\d{1,2}):(\d{1,2})$/)
		)
			return await interaction.reply({
				content: languageText("invalid_position_format", language),
			});
		const parts = unformattedString.split(":");
		let position = 0;
		for (let i = 0; i < parts.length; i++) {
			const part = Number(parts[i]);
			if (
				isNaN(part) ||
				part < 0 ||
				// allow hour to be any positive integer
				(part > 59 && i < parts.length - 1)
			)
				return await interaction.reply({
					content: languageText("invalid_position_format", language),
				});
			position += 60 ** (parts.length - (i + 1)) * part;
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

		if (!player || !player.isPlaying || !player.nowPlaying)
			return await interaction.reply({
				content: languageText("not_playing", language),
			});
		if (position >= player.nowPlaying.details.durationInSec)
			return await interaction.reply({
				content: languageText("position_overflow", language),
			});
		const resource = await createResource(player.nowPlaying.url, position);
		if (!resource)
			return await interaction.reply({
				content: languageText("fail_resource", language),
			});
		player.playResource(resource, true);
		await interaction.reply({
			content: languageText("relocate", language, {
				pos: timeFormat(position),
			}),
		});

		if (!resource.segments) return;
		const firstEl = resource.segments[0];
		if (firstEl)
			await sendInteractionSkipMessage(interaction, player);
	},
} as Command<SlashCommandBuilder>;
