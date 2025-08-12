import type { Command } from "../../lib/interaction";

import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	SlashCommandBuilder,
} from "discord.js";
import {
	getAudioPlayer,
	createResource,
	isVideo,
	isPlaylist,
	ensureVoiceConnection,
	timeFormat,
} from "../../lib/voice/core";
import {
	type YouTubePlayList,
	extractID,
	playlist_info,
	search,
} from "play-dl";
import { dcb, globalApp } from "../../lib/misc";
import { misc } from "../../lib/misc";
import { SegmentCategory } from "../../lib/voice/segment";

export default {
	data: new SlashCommandBuilder()
		.setName("play")
		.setDescription("Play music")
		.addStringOption((opt) =>
			opt
				.setName("search")
				.setDescription("Play a link or searching on YouTube")
				.setRequired(true),
		)
		.addBooleanOption((opt) =>
			opt
				.setName("force")
				.setDescription(
					"Skip the cache and force to download, only use when the song is not playing correctly",
				),
		)
		.addNumberOption((opt) =>
			opt
				.setName("volume")
				.setDescription("Set volume")
				.setMaxValue(500)
				.setMinValue(0),
		),
	async execute(interaction, client) {
		//prevent error caused by long response time
		await interaction.deferReply();

		if (!interaction.member || !("voice" in interaction.member)) {
			return interaction.editReply(misc.errorMessageObj);
		}

		const input = interaction.options.getString("search", true);
		const force = interaction.options.getBoolean("force") ?? false;

		const voiceChannel = interaction.member?.voice?.channel;

		const connection = ensureVoiceConnection(interaction);

		if (!voiceChannel || !connection) {
			interaction.editReply(
				"You need to be in a voice channel to play music",
			);
			return;
		}

		dcb.log(
			`Connected to voice channel (ID: ${voiceChannel.id}, Guild ID: ${interaction.guildId})`,
		);

		const audioPlayer = getAudioPlayer(client, interaction, {
			createPlayer: true,
		});

		if (!audioPlayer || !connection) {
			throw new Error("Execution Error");
		}
		connection.subscribe(audioPlayer);

		//searching data on youtube and add to queue
		// find if there is cache, cache is saved in YoutubeVideo form
		let videoUrl: string;
		if (isVideo(input)) {
			videoUrl = input;
		} else if (isPlaylist(input)) {
			let playlist: YouTubePlayList;
			const cached = client.cache.get(input);
			if (cached?.isPlaylist()) {
				playlist = cached.value;
			} else {
				playlist = await playlist_info(input, { incomplete: true });
				client.cache.set(input, playlist, "playlist");
			}
			const allVideos = await playlist.all_videos();

			audioPlayer.queue = audioPlayer.queue.concat(
				allVideos.map((v) => ({
					repeating: false,
					url: v.url,
				})),
			);
			videoUrl = audioPlayer.getNextQueueItem() ?? allVideos[0].url;
			if (!videoUrl)
				return interaction.editReply("The playlist is empty!");
		} else {
			const cached = client.cache.get(input);
			if (cached?.isVideo()) {
				videoUrl = cached.value.url;
			} else {
				const query = await search(input, {
					limit: 1,
				});
				if (!query.length) {
					return interaction.editReply(misc.errorMessageObj);
				}
				client.cache.set(input, query[0], "video");
				videoUrl = query[0].url;
			}
		}

		audioPlayer.addToQueue(videoUrl);
		// interaction content
		if (!audioPlayer.isPlaying) {
			dcb.log("Started to play music");
			try {
				const videoUrl = audioPlayer.getNextQueueItem();
				if (!videoUrl) {
					return interaction.editReply(misc.errorMessageObj);
				}
				const data = await createResource(videoUrl, undefined, force);
				if (!data) {
					return interaction.editReply(misc.errorMessageObj);
				}
				audioPlayer.playResource(data);

				dcb.log(`Playing Searched URL ${videoUrl}`);
				await interaction.editReply({
					content: `Playing ${data.title} (${videoUrl})`,
				});
				const skipTo = audioPlayer.currentSegment();
				if (!data.segments || !skipTo) return;
				const count = audioPlayer.playCounter;
				const response = await interaction.followUp({
					content: `Found non-music content at start, want to skip to \`${timeFormat(skipTo.segment[1])}\`?`,
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
						time: Math.min(10 * 1000, skipTo.segment[1] * 1000),
					});
					if (audioPlayer.playCounter !== count) {
						return confirmation.update({
							content: "The song has changed, skipping cancelled",
							components: [],
						});
					}
					if (confirmation.customId === "skip") {
						if (!(await audioPlayer.skipCurrentSegment())) {
							return confirmation.update({
								...misc.errorMessageObj,
								components: [],
							});
						}
						await confirmation.update({
							content: `Skipped to ${timeFormat(skipTo.segment[1])}`,
							components: [],
						});
					}
				} catch {
					if (response.deletable) {
						await response.delete().catch();
						return;
					}
					if (response.editable) {
						await response
							.edit({
								content: "Timed out, skipping cancelled",
								components: [],
							})
							.catch();
					}
				}

				return;
			} catch (e) {
				globalApp.err(
					"An error occurred while trying to start playing music: ",
					e,
				);
				return interaction.editReply({
					content: "An error occurred while processing the song",
				});
			}
		}

		dcb.log("Searched URL and added URL to queue");
		return await interaction.editReply({
			content: `Added ${isPlaylist(input) ? "playlist " : ""}${input}(${videoUrl}) to queue`,
		});
	},
} as Command<SlashCommandBuilder>;
