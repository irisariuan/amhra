import type { Command } from "../../lib/interaction";

import { SlashCommandBuilder } from "discord.js";
import {
	getAudioPlayer,
	getConnection,
	type TransformableResource,
} from "../../lib/voice/core";
import { video_info } from "play-dl";
import { dcb } from "../../lib/misc";
import { pageSize, sendPaginationMessage } from "../../lib/page";
import { languageText } from "../../lib/language";

export default {
	data: new SlashCommandBuilder()
		.setName("queue")
		.setDescription("Show the songs going to be played")
		.addIntegerOption((opt) =>
			opt
				.setMinValue(1)
				.setName("page")
				.setDescription("Page number of queue"),
		),
	async execute({ interaction, client, language }) {
		if (!interaction.guildId)
			return await interaction.reply({
				content: languageText("server_only_command", language),
			});

		await interaction.deferReply();
		const player = getAudioPlayer(
			client,
			interaction.guildId,
			interaction.channel,
			language,
		);
		if (!getConnection(interaction.guildId)) {
			dcb.log("Bot not in voice channel");
			return interaction.editReply({
				content: languageText("not_connected", language),
			});
		}
		if (!player) {
			dcb.log("Bot not playing song");
			return interaction.editReply({
				content: languageText("not_playing", language),
			});
		}
		if (player.queue.length <= 0) {
			dcb.log("Queue clear");
			return interaction.editReply({
				content: languageText("empty_queue", language),
			});
		}

		const page = Math.min(
			(interaction.options.getInteger("page") ?? 1) - 1,
			Math.ceil(player.queue.length / pageSize) - 1,
		);

		sendPaginationMessage(
			async () => {
				const songs = player.queue || [];
				const transformedSongs: TransformableResource[] = [];
				for (let i = 0; i < songs.length; i++) {
					if (!songs[i]) {
						continue;
					}
					const cachedUrl = client.cache.getUrl(songs[i].url);
					if (cachedUrl) {
						dcb.log("Founded cache, using cached URL");
					}
					const data = cachedUrl?.isVideo()
						? cachedUrl?.value
						: (await video_info(songs[i].url)).video_details;
					if (!cachedUrl) {
						client.cache.set(songs[i].url, data, "video");
					}

					transformedSongs.push({
						details: { durationInSec: data.durationInSec },
						title: data.title ?? "",
						url: songs[i].url,
					});
				}
				return transformedSongs;
			},
			interaction,
			language,
			page,
		);
	},
} as Command<SlashCommandBuilder>;
