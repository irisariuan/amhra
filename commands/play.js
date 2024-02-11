const { SlashCommandBuilder } = require("discord.js")
const {
	getAudioPlayer,
	createResource,
	isVideo,
	isPlaylist,
	joinVoice,
} = require("../lib/voice/core")
const { playlist_info, search } = require("play-dl")
const { CustomClient } = require("../lib/custom")
const { CommandInteraction } = require("discord.js")
const { dcb } = require("../lib/misc")
const misc = require("../lib/misc")

module.exports = {
	data: new SlashCommandBuilder()
		.setName("play")
		.setDescription("Play music")
		.addStringOption(opt =>
			opt
				.setName("search")
				.setDescription("Play a link or searching on YouTube")
				.setRequired(true)
		),
	/**
	 *
	 * @param {CommandInteraction} interaction
	 * @param {CustomClient} client
	 * @returns
	 */
	async execute(interaction, client) {
		//prevent error caused by long response time
		if (!interaction.member || !("voice" in interaction.member)) {
			return interaction.reply(misc.misc.errorMessageObj)
		}
		await interaction.deferReply()
		dcb.log("Called /play")
		// @ts-ignore
		const input = interaction.options.getString("search")

		let voiceChannel = interaction.member?.voice?.channel
		if (!voiceChannel) return

		const connection = joinVoice(voiceChannel, interaction)
		dcb.log("Connected")
		const audioPlayer = getAudioPlayer(client, interaction, {
			createPlayer: true,
		})

		if (typeof audioPlayer === "boolean" || !audioPlayer) {
			throw new Error("Execution Error")
		}
		connection.subscribe(audioPlayer)

		//searching data on youtube and add to queue
		// the video will be auto played by audioPlayer, it is not handled here

		// find if there is cache, cache is saved by YoutubeVideo form
		const cachedUrl = client.cache.get(input)
		if (cachedUrl) {
			dcb.log("Found cache, using cache " + cachedUrl)
		}
		let url = input
		let playlistInfo = cachedUrl

		if (!isVideo(input)) {
			if (!cachedUrl) {
				const result = await search(input, { limit: 1 })
				client.cache.set(input, result[0])
				url = result[0].url
			} else {
				// transfer YoutubeVideo back to url
				url = cachedUrl.url
			}
		} else if (isPlaylist(input)) {
			if (playlistInfo === null) {
				playlistInfo = await playlist_info(url, { incomplete: true })
				client.cache.set(input, playlistInfo)
			}
			audioPlayer.queue = audioPlayer.queue.concat(
				(await playlistInfo.all_videos()).map(v => v.url)
			)
		}

		audioPlayer.queue.push(url)
		// interaction content
		if (!audioPlayer.isPlaying) {
			dcb.log("Started to play music")
			try {
				const data = await createResource(audioPlayer.queue.shift())
				data.resource.volume?.setVolume(audioPlayer.volume)
				audioPlayer.isPlaying = true
				audioPlayer.nowPlaying = data

				audioPlayer.play(data.resource)

				if (isPlaylist(url)) {
					dcb.log("Playing playlist")
					if (!playlistInfo)
						return await interaction.editReply({
							content: "Cannot find any playlist!",
						})
					return await interaction.editReply({
						content: `Playing playlist ${playlistInfo.title} (${playlistInfo.url})`,
					})
				}
				if (input !== url) {
					dcb.log("Playing Searched URL")
					return await interaction.editReply({
						content: `Playing ${data.title} (${url})`,
					})
				}
				dcb.log("Interaction included the URL")
				await interaction.editReply({
					content: `Playing ${data.title}`,
				})
			} catch (error) {
				console.error(
					"An error occurred while trying to start playing music: ",
					error
				)
				interaction.editReply({
					content: "An error occurred while processing the song",
				})
			}
		} else {
			dcb.log("Added into queue")
			if (input !== url) {
				dcb.log("Searched URL and added URL to queue")
				return await interaction.editReply({
					content: `Added ${input}(${url}) to queue`,
				})
			}
			dcb.log("Added URL to queue")
			await interaction.editReply({
				content: `Added ${input} into queue`,
			})
		}
	},
}
