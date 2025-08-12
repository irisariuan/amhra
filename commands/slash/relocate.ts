import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	SlashCommandBuilder,
} from "discord.js";
import {
	createResource,
	getAudioPlayer,
	timeFormat,
} from "../../lib/voice/core";
import type { Command } from "../../lib/interaction";
import { extractID } from "play-dl";
import { misc } from "../../lib/misc";
import { getSegments, SegmentCategory } from "../../lib/voice/segment";

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
	async execute(interaction, client) {
		const unformattedString = interaction.options.getString(
			"position",
			true,
		);
		if (
			!unformattedString.match(/^\d+$/) &&
			!unformattedString.match(/^(?:(\d{1,}):)?(\d{1,2}):(\d{1,2})$/)
		)
			return await interaction.reply({
				content:
					"Invalid position format. Use seconds or (HH:)MM:SS format.",
			});
		const parts = unformattedString.split(":");
		let position = 0;
		for (let i = 0; i < parts.length; i++) {
			const part = Number(parts[i]);
			if (isNaN(part) || part < 0 || (part > 59 && i < parts.length - 1))
				return await interaction.reply({
					content:
						"Invalid position format. Use seconds or HH:MM:SS format.",
				});
			position += 60 ** (parts.length - (i + 1)) * part;
		}

		const player = getAudioPlayer(client, interaction, {
			createPlayer: false,
		});

		if (!player || !player.isPlaying || !player.nowPlaying)
			return await interaction.reply({
				content: "I am not playing any song",
			});
		if (position >= player.nowPlaying.details.durationInSec)
			return await interaction.reply({
				content: "Position is greater than song duration",
			});
		const resource = await createResource(player.nowPlaying.url, position);
		if (!resource)
			return await interaction.reply({
				content: "Failed to create resource",
			});
		player.playResource(resource, true);
		await interaction.reply({
			content: `Relocated the song to ${timeFormat(position)}`,
		});

		if (!resource.segments) return;
		const firstEl = resource.segments.at(0);
		if (firstEl?.category === SegmentCategory.MusicOffTopic) {
			const [start, newStart] = firstEl.segment;
			const count = player.playCounter;
			if (start !== 0 || position >= newStart) return;
			const response = await interaction.followUp({
				content: `Found non-music content at start, want to skip to \`${timeFormat(newStart)}\`?`,
				components: [
					new ActionRowBuilder<ButtonBuilder>().addComponents(
						new ButtonBuilder()
							.setLabel("Skip")
							.setStyle(ButtonStyle.Primary)
							.setCustomId("skip"),
					),
				],
			});
			try {
				const confirmation = await response.awaitMessageComponent({
					time: 10 * 1000,
				});
				if (player.playCounter !== count) {
					return confirmation.update({
						content: "The song has changed, skipping cancelled",
						components: [],
					});
				}
				if (confirmation.customId === "skip") {
					const data = await createResource(player.nowPlaying.url, newStart);
					if (!data) {
						return confirmation.update(misc.errorMessageObj);
					}
					player.playResource(data, true);
					await confirmation.update({
						content: `Skipped to ${timeFormat(newStart)}`,
						components: [],
					});
				}
			} catch {}
		}
	},
} as Command<SlashCommandBuilder>;
