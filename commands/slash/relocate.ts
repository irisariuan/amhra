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
import { SegmentCategory } from "../../lib/voice/segment";
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
			if (isNaN(part) || part < 0 || (part > 59 && i < parts.length - 1))
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
		const firstEl = resource.segments.at(0);
		if (firstEl?.category === SegmentCategory.MusicOffTopic) {
			const [start, skipTo] = firstEl.segment;
			const count = player.playCounter;
			if (start !== 0 || position >= skipTo) return;
			const response = await interaction.followUp({
				content: languageText("segment_skip_message", language, {
					pos: timeFormat(skipTo),
					posNum: Math.round(skipTo),
				}),
				components: [
					new ActionRowBuilder<ButtonBuilder>().addComponents(
						new ButtonBuilder()
							.setLabel(languageText("skip_label", language))
							.setStyle(ButtonStyle.Primary)
							.setCustomId("skip"),
					),
				],
			});
			try {
				const confirmation = await response.awaitMessageComponent({
					time: Math.min(10 * 1000, skipTo * 1000),
				});
				if (player.playCounter !== count) {
					return confirmation.update({
						content: languageText(
							"skip_cancel_song_changed",
							player.currentLanguage,
						),
						components: [],
					});
				}
				if (confirmation.customId === "skip") {
					const result = await player.skipCurrentSegment();
					if (!result.success) {
						return confirmation.update({
							...misc.errorMessageObj(player.currentLanguage),
							components: [],
						});
					}
					await confirmation.update({
						content: languageText(
							result.skipped
								? "SEGMENT_SKIP_NEXT"
								: "SEGMENT_SKIP",
							player.currentLanguage,
							{
								pos: timeFormat(skipTo),
							},
						),
						components: [],
					});
				}
			} catch {
				if (response.deletable) {
					await response.delete().catch(() => {});
					return;
				}
				if (response.editable) {
					await response.reactions.removeAll().catch(() => {});
					await response
						.edit({
							content: languageText(
								"skip_cancel_timeout",
								language,
							),
							components: [],
						})
						.catch(() => {});
				}
			}
		}
	},
} as Command<SlashCommandBuilder>;
