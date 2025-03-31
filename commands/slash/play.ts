import type { Command } from "../../lib/interaction"

import { SlashCommandBuilder } from "discord.js"
import {
	getAudioPlayer,
	createResource,
	isVideo,
	isPlaylist,
	joinVoice,
} from "../../lib/voice/core"
import { type YouTubePlayList, playlist_info, search } from "play-dl"
import { dcb, globalApp } from "../../lib/misc"
import { misc } from "../../lib/misc"

export default {
	data: new SlashCommandBuilder()
		.setName("play")
		.setDescription("Play music")
		.addStringOption(opt =>
			opt
				.setName("search")
				.setDescription("Play a link or searching on YouTube")
				.setRequired(true)
		),
	async execute(interaction, client) {
		//prevent error caused by long response time
		await interaction.deferReply()

		if (!interaction.member || !("voice" in interaction.member)) {
			return interaction.editReply(misc.errorMessageObj)
		}

		const input = interaction.options.getString("search", true)

		const voiceChannel = interaction.member?.voice?.channel
		if (!voiceChannel) {
			interaction.editReply('You need to be in a voice channel to play music')
			return
		}

		const connection = joinVoice(voiceChannel, interaction)
		dcb.log(`Connected to voice channel (ID: ${voiceChannel.id}, Guild ID: ${interaction.guildId})`)

		const audioPlayer = getAudioPlayer(client, interaction, {
			createPlayer: true,
		})

		if (typeof audioPlayer === "boolean" || !audioPlayer || !connection) {
			throw new Error("Execution Error")
		}
		connection.subscribe(audioPlayer)

		//searching data on youtube and add to queue
		// find if there is cache, cache is saved in YoutubeVideo form
		let videoUrl: string | undefined | null
		if (isVideo(input)) {
			videoUrl = input
		} else if (isPlaylist(input)) {
			let playlist: YouTubePlayList
			const cached = client.cache.get(input)
			if (cached?.isPlaylist()) {
				playlist = cached.value
			} else {
				playlist = await playlist_info(input, { incomplete: true })
				client.cache.set(input, playlist, 'playlist')
			}
			audioPlayer.queue = audioPlayer.queue.concat((await playlist.all_videos()).map(v => ({
				repeating: false,
				url: v.url,
			})))
			videoUrl = audioPlayer.getNextQueueItem()
			if (!videoUrl) return interaction.editReply('The playlist is empty!')
		} else {
			const cached = client.cache.get(input)
			if (cached?.isVideo()) {
				videoUrl = cached.value.url
			} else {
				const query = await search(input, {
					limit: 1,
				})
				if (!query.length) {
					return interaction.editReply(misc.errorMessageObj)
				}
				client.cache.set(input, query[0], 'video')
				videoUrl = query[0].url
			}
		}

		audioPlayer.addToQueue(videoUrl)
		// interaction content
		if (!audioPlayer.isPlaying) {
			dcb.log("Started to play music")
			try {
				const videoUrl = audioPlayer.queue.shift()
				if (!videoUrl) {
					return interaction.editReply(misc.errorMessageObj)
				}
				const data = await createResource(videoUrl.url)
				if (!data) {
					return interaction.editReply(misc.errorMessageObj)
				}
				audioPlayer.playResource(data)

				dcb.log(`Playing Searched URL ${videoUrl.url}`)
				return await interaction.editReply({
					content: `Playing ${data.title} (${videoUrl.url})`,
				})
			} catch (e) {
				globalApp.err(
					"An error occurred while trying to start playing music: ",
					e
				)
				return interaction.editReply({
					content: "An error occurred while processing the song",
				})
			}
		}

		dcb.log("Searched URL and added URL to queue")
		return await interaction.editReply({
			content: `Added ${isPlaylist(input) ? 'playlist ' : ''}${input}(${videoUrl}) to queue`,
		})

	},
} as Command<SlashCommandBuilder>
