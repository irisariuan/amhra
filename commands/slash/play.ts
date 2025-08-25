import { type Command } from "../../lib/interaction";

import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	SlashCommandBuilder,
} from "discord.js";
import { type YouTubePlayList, playlist_info, search } from "play-dl";
import { dcb, globalApp, misc } from "../../lib/misc";
import {
	createResource,
	ensureVoiceConnection,
	getAudioPlayer,
	getBotVoiceChannel,
	getConnection,
	isPlaylist,
	isVideo,
	timeFormat,
} from "../../lib/voice/core";
import { languageText } from "../../lib/language";

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
		if (
			botVoiceChannel &&
			// existing connection
			getConnection(interaction.guild.id) &&
			interaction.member.voice.channel.id !== botVoiceChannel.id
		) {
			return await interaction.reply({
				content: languageText("not_same_voice", language),
			});
		}
		//prevent error caused by long response time

		await interaction.deferReply();

		if (!interaction.member || !("voice" in interaction.member)) {
			return interaction.editReply(misc.errorMessageObj(language));
		}

		const input = interaction.options.getString("search", true);
		const force = interaction.options.getBoolean("force") ?? false;
		const voiceChannel = interaction.member.voice.channel;
		const connection = ensureVoiceConnection(interaction);

		dcb.log(
			`Connected to voice channel (ID: ${voiceChannel.id}, Guild ID: ${interaction.guildId})`,
		);

		const player = getAudioPlayer(
			client,
			interaction.guild.id,
			interaction.channel,
			language,
			{
				createPlayer: true,
			},
		);

		if (!player || !connection) {
			throw new Error("Execution Error");
		}
		connection.subscribe(player);

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

			player.queue = player.queue.concat(
				allVideos.map((v) => ({
					repeating: false,
					url: v.url,
				})),
			);
			videoUrl = player.getNextQueueItem() ?? allVideos[0].url;
			if (!videoUrl)
				return interaction.editReply(
					languageText("empty_playlist", language),
				);
		} else {
			const cached = client.cache.get(input);
			if (cached?.isVideo()) {
				videoUrl = cached.value.url;
			} else {
				const query = await search(input, {
					limit: 1,
				});
				if (!query.length) {
					return interaction.editReply(
						misc.errorMessageObj(language),
					);
				}
				client.cache.set(input, query[0], "video");
				videoUrl = query[0].url;
			}
		}

		player.addToQueue(videoUrl);
		// interaction content
		if (!player.isPlaying) {
			dcb.log("Started to play music");
			try {
				const videoUrl = player.getNextQueueItem();
				if (!videoUrl) {
					return interaction.editReply(
						misc.errorMessageObj(language),
					);
				}
				const data = await createResource(videoUrl, undefined, force);
				if (!data) {
					return interaction.editReply(
						misc.errorMessageObj(language),
					);
				}
				player.playResource(data);

				dcb.log(`Playing Searched URL ${videoUrl}`);
				await interaction.editReply({
					content: languageText("playing_display", language, {
						title: data.title,
						url: videoUrl,
					}),
				});
				const skipTo = player.currentSegment();
				if (!data.segments || !skipTo) return;
				const count = player.playCounter;
				const response = await interaction.followUp({
					content: languageText("segment_skip_message", language, {
						pos: timeFormat(skipTo.segment[1]),
						posNum: Math.round(skipTo.segment[1]),
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
						time: Math.min(10 * 1000, skipTo.segment[1] * 1000),
					});
					if (player.playCounter !== count) {
						return confirmation.update({
							content: languageText(
								"SKIP_CANCEL_SONG_CHANGED",
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
									pos: timeFormat(skipTo.segment[1]),
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
									"SKIP_CANCEL_TIMEOUT",
									language,
								),
								components: [],
							})
							.catch(() => {});
					}
				}

				return;
			} catch (e) {
				globalApp.err(
					"An error occurred while trying to start playing music: ",
					e,
				);
				return interaction.editReply(languageText("error", language));
			}
		}

		dcb.log("Searched URL and added URL to queue");
		return await interaction.editReply({
			content: languageText(
				isPlaylist(input) ? "PLAYLIST_ADD_TO_QUEUE" : "ADD_TO_QUEUE",
				language,
				{
					input,
					url: videoUrl,
				},
			),
		});
	},
} as Command<SlashCommandBuilder>;
