const { Client, ClientOptions } = require("discord.js")
const { AudioPlayer } = require("@discordjs/voice")
const { SearchCache } = require("./cache")
const { AudioResource } = require("@discordjs/voice")
const { YouTubeChannel, YouTubeVideo } = require("play-dl")
function generateToken(n) {
	var chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	var token = '';
	for (var i = 0; i < n; i++) {
		token += chars[Math.floor(Math.random() * chars.length)];
	}
	return token;
}
class CustomClient extends Client {
	/**
	 * @description GuildID, AudioPlayer
	 * @type {Map<string, CustomAudioPlayer>}
	 */
	player
	/**
	 * @type {SearchCache}
	 */
	cache
	/**
	 * @type {Map<string, {guilds: string[], level: number}> | null}
	 */
	levelMap

	/**
	 * @type {Map<string, string>}
	 */
	savedLevelMap

	/**
	 * @param {ClientOptions} clientOpt 
	 */
	constructor(clientOpt) {
		super(clientOpt)
		/**
		 * @type {Map<string, CustomAudioPlayer>}
		 */
		this.player = new Map()
		this.cache = new SearchCache()
		this.levelMap = new Map()
		/**
		 * @description GuildID, Token
		 * @type {Map<string, string>}
		 */
		this.savedLevelMap = new Map()
	}
	/**
	 * 
	 * @param {string} guildId Guild ID
	 * @returns {{token: string, guilds: string[], level: number}}
	 */
	newToken(guildId) {
		const token = generateToken(36)
		const level = 1
		this.levelMap.set(token, { guilds: [guildId], level })
		return { token, guilds: [guildId], level }
	}
	/**
	 * 
	 * @param {string} guildId Guild Id
	 * @returns {string | null}
	 */
	createToken(guildId) {
		if (this.savedLevelMap.has(guildId)) {
			return this.savedLevelMap.get(guildId) ?? null
		}
		const { token } = this.newToken(guildId)
		this.savedLevelMap.set(guildId, token)
		return token
	}
}

class CustomAudioPlayer extends AudioPlayer {
	/**
	 * @type {number}
	 */
	volume
	/**
	 * @type {{resource: AudioResource<any>, channel: YouTubeChannel, title: string, details: YouTubeVideo, url: string,} | null}
	 */
	nowPlaying
	/**
	 * @type {boolean}
	 */
	isPlaying
	/**
	 * @type {string[]}
	 */
	queue
	/**
	 * @type {string}
	 */
	guildId

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

	resetAll() {
		this.stop()
		this.volume = 1
		this.queue = []
		this.isPlaying = false
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
	/**
	 * @param {number} volume 
	 */
	setVolume(volume) {
		this.volume = volume
		if (this.isPlaying && this.nowPlaying.resource) {
			this.nowPlaying.resource.volume?.setVolume(volume)
		}
	}
	resetPlaying() {
		this.isPlaying = false
		this.nowPlaying = null
	}

	/**
	 * @returns {{song: null | {link: string, channel: string, duration: number, title: string, thumbnails: string[]}, queue: string[], volume: number, isPlaying: boolean}}
	 */
	getData() {
		return {
			song: this.nowPlaying
				? {
					link: this.nowPlaying.url,
					channel: this.nowPlaying.channel.url,
					duration: this.nowPlaying.details.durationInSec,
					title: this.nowPlaying.details.title,
					thumbnails: this.nowPlaying.details.thumbnails.map((v) => v.url),
				}
				: null,
			queue: this.queue,
			volume: this.volume,
			isPlaying: this.isPlaying,
		}
	}
}

module.exports = {
	CustomClient,
	CustomAudioPlayer,
}
