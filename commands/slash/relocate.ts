import { SlashCommandBuilder } from "discord.js";
import { createResource, getAudioPlayer } from "../../lib/voice/core";
import type { Command } from "../../lib/interaction";

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
			content: `Relocated the song to position ${position} seconds`,
		});
	},
} as Command<SlashCommandBuilder>;
