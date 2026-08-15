import { type Command } from "../../lib/interaction";

import { SlashCommandBuilder } from "discord.js";
import {
	getYouTubePlaylist,
	searchYouTube,
	type YouTubePlaylist,
	type YouTubeVideo,
} from "../../lib/youtube";
import { languageText } from "../../lib/language";
import { dcb, globalApp, misc } from "../../lib/misc";
import {
	createResource,
	ensureVoiceConnection,
	getAudioPlayer,
	getBotVoiceChannel,
	getConnection,
	isPlaylist,
	isVideo,
} from "../../lib/voice/core";
import { sendInteractionSkipMessage } from "../../lib/voice/segment";
import { sendSearchAlternatives } from "../../lib/voice/searchPick";

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
		.addBooleanOption((opt) =>
			opt.setName("next").setDescription("Add the song to play next"),
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
		const next = interaction.options.getBoolean("next") ?? false;
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
		);

		if (!player || !connection) {
			throw new Error("Execution Error");
		}
		connection.subscribe(player);

		//searching data on youtube and add to queue
		// find if there is cache, cache is saved in YoutubeVideo form
		// resultUrl could be a video or playlist
		let resultUrl: string;
		// Set only when the input was a free-text search, so the user can be
		// offered the other hits once something is already playing
		let alternatives: {
			results: YouTubeVideo[];
			chosenUrl: string;
		} | null = null;
		// Checked before the video case: a link shared from an open playlist is a
		// watch URL carrying `list=`, and reading it as a single video would
		// queue one song where the whole set was asked for
		if (isPlaylist(input)) {
			let playlist: YouTubePlaylist;
			const cached = client.cache.get(input);
			if (cached?.isPlaylist()) {
				playlist = cached.value;
			} else {
				try {
					playlist = await getYouTubePlaylist(input);
				} catch (e) {
					globalApp.err("Failed to read playlist: ", e);
					return interaction.editReply(
						languageText("error", language),
					);
				}
				client.cache.set(input, playlist, "playlist");
			}

			if (!playlist.videos.length)
				return interaction.editReply(
					languageText("empty_playlist", language),
				);
			player.bulkAddToQueue(
				playlist.videos.map((v) => v.url),
				false,
				next ? 0 : undefined,
			);
			resultUrl = playlist.url;
		} else if (isVideo(input)) {
			resultUrl = input;
			player.addToQueue(resultUrl, false, next ? 0 : undefined);

			// searching on YouTube
		} else {
			// Kept so the user can switch to another hit afterwards; a cache hit
			// only remembers the best match, so there is nothing to offer then
			let searchResults: YouTubeVideo[] = [];
			const cached = client.cache.get(input);
			if (cached?.isVideo()) {
				resultUrl = cached.value.url;
			} else {
				const query = await searchYouTube(input);
				if (!query.length) {
					return interaction.editReply(
						misc.errorMessageObj(language),
					);
				}
				client.cache.set(input, query[0], "video");
				resultUrl = query[0].url;
				searchResults = query;
			}
			player.addToQueue(resultUrl, false, next ? 0 : undefined);
			alternatives = { results: searchResults, chosenUrl: resultUrl };
		}

		// start playing if the player is not playing
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
				if (alternatives) {
					await sendSearchAlternatives({
						interaction,
						player,
						...alternatives,
					});
				}
				if (data.segments && player.currentSegment()) {
					if (player.customSetting.autoSkipSegment) {
						await player.skipCurrentSegment();
					} else {
						await sendInteractionSkipMessage(interaction, player);
					}
				}
				// The track is playing, not queued. Falling through to the
				// queue reply below would overwrite "now playing" with "added
				// to queue" and offer the search alternatives a second time.
				return;
			} catch (e) {
				globalApp.err(
					"An error occurred while trying to start playing music: ",
					e,
				);
				return interaction.editReply(languageText("error", language));
			}
		}

		// respond to interaction
		dcb.log("Searched URL and added URL to queue");
		const baseText = isPlaylist(input)
			? "playlist_add_to_queue"
			: "add_to_queue";
		const reply = await interaction.editReply({
			content: languageText(
				next ? `${baseText}_next` : baseText,
				language,
				{
					input,
					url: resultUrl,
				},
			),
		});
		if (alternatives) {
			await sendSearchAlternatives({
				interaction,
				player,
				...alternatives,
			});
		}
		return reply;
	},
} as Command<SlashCommandBuilder>;
