const { Client } = require("discord.js")
const { AudioPlayer } = require("@discordjs/voice")
const { SearchCache } = require("./cache")
const { AudioResource } = require("@discordjs/voice")
const { YouTubeChannel, YouTubeVideo } = require("play-dl")

class CustomClient extends Client {
	/**
	 * @description GuildID, AudioPlayer
	 * @type {Map<string, CustomAudioPlayer>}
	 */
	player = new Map()
	/**
	 * @type {SearchCache}
	 */
	cache = new SearchCache()
}

class CustomAudioPlayer extends AudioPlayer {
	/**
	 * @param {string} guildId Guild ID of the player
	 * @param {import("@discordjs/voice").CreateAudioPlayerOptions} options 
	 */
	constructor(guildId, options = undefined) {
		super(options)
		this.volume = 1
		this.isPlaying = false
		this.nowPlaying = null
		this.queue = []
		this.guildId = guildId
	}

	/**
	 * @type {{resource: AudioResource<any>, channel: YouTubeChannel, title: string, details: YouTubeVideo, url: string,} | null}
	 */
	resetAll() {
		this.volume = 1
		this.isPlaying = false
		this.queue = []
		this.nowPlaying = null
	}
	cleanStop() {
		if (this.stop()) {
			this.queue = []
			this.isPlaying = false
			this.nowPlaying = null
			return true
		}
		return false
	}
	/**
	 *
	 * @param {{resource: AudioResource<any>, channel: YouTubeChannel, title: string, details: YouTubeVideo, url: string}} resource
	 */
	playResource(resource) {
		resource.resource.volume?.setVolume(this.volume)
		this.nowPlaying = resource
		this.isPlaying = true
		this.play(resource.resource)
	}
	setVolume(volume) {
		this.volume = volume
		if (this.isPlaying && this.nowPlaying) {
			this.nowPlaying.resource.volume?.setVolume(volume)
		}
	}
	resetPlaying() {
		this.isPlaying = false
		this.nowPlaying = null
	}
}

module.exports = {
	CustomClient,
	CustomAudioPlayer,
}
