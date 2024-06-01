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
		// @ts-ignore
		const input = interaction.options.getString("search")

		const voiceChannel = interaction.member?.voice?.channel
		if (!voiceChannel) return

		const connection = joinVoice(voiceChannel, interaction)
		dcb.log(`Connected to voice channel (ID: ${voiceChannel.id}, Guild ID: ${interaction.guildId})`)

		const audioPlayer = getAudioPlayer(client, interaction, {
			createPlayer: true,
		})

		if (typeof audioPlayer === "boolean" || !audioPlayer) {
			throw new Error("Execution Error")
		}
		connection.subscribe(audioPlayer)

		//searching data on youtube and add to queue
		// find if there is cache, cache is saved in YoutubeVideo form
		const cachedUrl = client.cache.get(input)
		if (cachedUrl) {
			dcb.log(`Found cache, using cache ${cachedUrl}`)
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
				...(await playlistInfo.all_videos()).map(v => v.url)
			)
		}

		audioPlayer.addToQueue(url)
		// interaction content
		if (!audioPlayer.isPlaying) {
			dcb.log("Started to play music")
			try {
				const data = await createResource(audioPlayer.queue.shift())
				audioPlayer.playResource(data)

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
