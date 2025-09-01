import { type Command } from "../../lib/interaction";

import { SlashCommandBuilder } from "discord.js";
import { type YouTubePlayList, playlist_info, search } from "play-dl";
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
		if (isVideo(input)) {
			resultUrl = input;
			player.addToQueue(resultUrl, false, next ? 0 : undefined);
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

			if (!playlist.url)
				return interaction.editReply(
					languageText("empty_playlist", language),
				);
			player.bulkAddToQueue(
				allVideos.map((v) => v.url),
				false,
				next ? 0 : undefined,
			);
			resultUrl = playlist.url;

			// searching on YouTube
		} else {
			const cached = client.cache.get(input);
			if (cached?.isVideo()) {
				resultUrl = cached.value.url;
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
				resultUrl = query[0].url;
			}
			player.addToQueue(resultUrl, false, next ? 0 : undefined);
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
				if (!data.segments) return;
				if (player.currentSegment()) {
					if (player.customSetting.autoSkipSegment) {
						return await player.skipCurrentSegment();
					}
					return await sendInteractionSkipMessage(
						interaction,
						player,
					);
				}
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
		return await interaction.editReply({
			content: languageText(
				next ? `${baseText}_next` : baseText,
				language,
				{
					input,
					url: resultUrl,
				},
			),
		});
	},
} as Command<SlashCommandBuilder>;
