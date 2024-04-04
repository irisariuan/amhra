const {
	createAudioResource,
	AudioPlayerStatus,
	joinVoiceChannel,
	getVoiceConnection,
	AudioResource,
} = require("@discordjs/voice")
const {
	stream,
	video_info,
	YouTubeChannel,
	YouTubeVideo,
	yt_validate,
} = require("play-dl")
const { CommandInteraction } = require("discord.js")
const { CustomAudioPlayer, CustomClient } = require("../custom")
const { dcb, globalApp } = require("../misc")
const { event } = require("../express/event")
const NodeCache = require("node-cache")

const cache = new NodeCache()

/**
 *
 * @param {string} guildId
 * @param {CustomClient} client
 * @param {object} createOpts
 * @returns
 */
function createAudioPlayer(guildId, client, createOpts = {}) {
	//create a player and initialize it if there isn't one
	const player = new CustomAudioPlayer(createOpts)

	//continue to play song after ending one
	player.on(AudioPlayerStatus.Idle, async () => {
		if (!player) {
			return
		}
		setTimeout(() => {
			if (player.isPlaying || player.queue.length > 0) {
				return
			}
			dcb.log("Auto quitted for inactivity")
			player.cleanStop()
			const connection = getVoiceConnection(guildId)
			destroyAudioPlayer(client, guildId)
			if (connection) {
				connection.disconnect()
				connection.destroy()
			}
		}, 15 * 60 * 1000)
		try {
			dcb.log("Finished music playing")
			if (player.queue.length > 0) {
				const nextUrl = player.queue.shift()
				const resource = await createResource(nextUrl)

				event.emit("songInfo", nextUrl)
				player.playResource(resource)
				dcb.log("Playing next music")
			} else {
				player.resetPlaying()
				dcb.log("Finished playing all music")
				player.cleanStop()
			}
		} catch (error) {
			dcb.log(`Error: ${error}`)
			player.resetPlaying()
		}
	})

	return player
}

/**
 * @param {CustomClient} client
 * @param {CommandInteraction} interaction
 * @param {object} option
 * @param {boolean} [option.createPlayer=true]
 * @param {object} [option.createOpts={}]
 * @param {boolean} [option.fail=false]
 * @returns {( CustomAudioPlayer | null )}
 */
function getAudioPlayer(
	client,
	interaction,
	option = { createPlayer: true, createOpts: {}, fail: false },
) {
	if (!interaction.guild) {
		return null
	}

	const player = client.player.get(interaction.guild.id) ?? null

	if (!player && option.createPlayer) {
		const player = createAudioPlayer(interaction.guild.id, client, {})
		client.player.set(interaction.guild.id, player)
		return player
	}

	return player
}

/**
 * @param {CustomClient} client
 * @param {string} guildId
 * @returns {boolean}
 */
function destroyAudioPlayer(client, guildId) {
	if (client.player.has(guildId)) {
		// reset player to the init status
		client.player.get(guildId)?.resetAll()
		const token = client.savedLevelMap.get(guildId)
		if (token) {
			client.levelMap.delete(token)
			client.savedLevelMap.delete(guildId)
		}
		client.player.delete(guildId)
		return true
	}
	return false
}

function getConnection(interaction) {
	const connection = getVoiceConnection(interaction.guildId)
	if (!connection) return false
	return connection
}

/**
 *
 * @param {String} url
 * @param {number | undefined} seek
 * @returns {Promise<{resource: AudioResource, channel: YouTubeChannel, title: String, details: YouTubeVideo, url: String}>}
 */
async function createResource(url, seek = undefined) {
	const source = await stream(url, { seek })
	let videoInfo
	if (cache.get(url)) {
		videoInfo = cache.get(url)
	} else {
		videoInfo = await video_info(url)
		cache.set(url, videoInfo)
	}
	const detail = videoInfo.video_details
	const res = createAudioResource(source.stream, {
		inputType: source.type,
		inlineVolume: true,
	})
	if (!detail.channel || !detail.title) {
		throw new Error(
			"Resource could not be created due to channel and title missing",
		)
	}
	return {
		resource: res,
		channel: detail.channel,
		title: detail.title,
		details: detail,
		url,
	}
}

function joinVoice(voiceChannel, interaction) {
	return joinVoiceChannel({
		channelId: voiceChannel.id,
		guildId: voiceChannel.guildId,
		adapterCreator: interaction.guild.voiceAdapterCreator,
		selfDeaf: false,
		selfMute: false,
	})
}

function isYoutube(query) {
	return yt_validate(query) !== false
}

function isVideo(link) {
	return yt_validate(link) === "video"
}

function isPlaylist(link) {
	return yt_validate(link) === "playlist"
}

// https://stackoverflow.com/questions/3733227/javascript-seconds-to-minutes-and-seconds
function timeFormat(duration) {
	let dur = duration
	if (typeof duration === "string") {
		dur = Number.parseInt(duration)
	}
	// Hours, minutes and seconds
	const hrs = ~~(dur / 3600)
	const mins = ~~((dur % 3600) / 60)
	const secs = ~~dur % 60

	// Output like "1:01" or "4:03:59" or "123:03:59"
	let result = ""

	if (hrs > 0) {
		result += `${hrs}:${mins < 10 ? "0" : ""}`
	}

	result += `${mins}:${secs < 10 ? "0" : ""}`
	result += `${secs}`

	return result
}
/**
 *
 * @param {*} d
 * @param {number | null} i
 * @returns
 */
function songToString(d, i = null) {
	return `${i ? `\`${i}.\` ` : ""}${d.title} \`${timeFormat(
		d.details.durationInSec || d.durationInSec,
	)}\``
}

module.exports = {
	getAudioPlayer,
	createResource,
	joinVoice,
	getConnection,
	isPlaylist,
	isVideo,
	isYoutube,
	songToString,
	destroyAudioPlayer,
}
