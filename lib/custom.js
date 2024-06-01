const { Client, ClientOptions } = require("discord.js")
const { AudioPlayer } = require("@discordjs/voice")
const { SearchCache } = require("./cache")
const { AudioResource } = require("@discordjs/voice")
const { YouTubeChannel, YouTubeVideo } = require("play-dl")
function generateToken(n) {
	const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
	let token = ''
	for (let i = 0; i < n; i++) {
		token += chars[Math.floor(Math.random() * chars.length)]
	}
	return token
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
	 * @type {boolean}
	 */
	isPaused
	/**
	 * @type {number}
	 */
	startTime
	/**
	 * @type {number[]}
	 */
	timeoutList
	/**
	 * @type {number}
	 */
	pauseCounter
	/**
	 * @type {number}
	 */
	pauseTimestamp

	/**
	 * @param {string} guildId Guild ID of the player
	 * @param {import("@discordjs/voice").CreateAudioPlayerOptions} options
	 */
	constructor(guildId, options = undefined) {
		super(options)
		this.guildId = guildId
		
		this.volume = 1

		this.isPlaying = false
		this.nowPlaying = null
		
		this.queue = []
		this.history = []
		
		/**
		 * @description Timestamp when the music is played
		 */
		this.startTime = 0
		/**
		 * @description Time in ms when the music is started from 
		 */
		this.startFrom = 0
		this.isPaused = false
		this.pauseCounter = 0
		this.pauseTimestamp = 0
		
		this.looping = false

		this.timeoutList = []
	}
	
	resetAll() {
		this.stop()
		this.volume = 1
		this.reset()
	}
	
	reset() {
		this.pauseCounter = 0
		this.pauseTimestamp = 0
		this.queue = []
		this.isPlaying = false
		this.nowPlaying = null
		this.isPaused = false
		this.startTime = 0
		this.startFrom = 0
	}

	cleanStop() {
		if (this.stop()) {
			this.reset()
			return true
		}
		return false
	}

	clearIntervals() {
		for (const id of this.timeoutList) {
			this.timeoutList.splice(0, 1)
			clearInterval(id)
		}
	}

	/**
	 *
	 * @param {{resource: AudioResource<any>, channel: YouTubeChannel, title: string, details: YouTubeVideo, url: string, startFrom?: number}} resource
	 */
	playResource(resource) {
		resource.resource.volume?.setVolume(this.volume)
		this.nowPlaying = resource
		this.isPlaying = true
		this.isPaused = false
		this.pauseCounter = 0
		this.startTime = Date.now()
		this.startFrom = resource.startFrom ?? 0
		resource.resource.volume.setVolume(this.volume)
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
	 * @returns {{song: null | {link: string, channel: string, duration: number, title: string, thumbnails: string[], startFrom: number}, queue: string[], volume: number, isPlaying: boolean}}
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
					startTime: this.startTime,
					startFrom: this.startFrom,
				}
				: null,
			queue: this.queue,
			history: this.history,
			volume: this.volume,
			isPlaying: this.isPlaying,
			paused: this.isPaused,
			pausedInMs: this.pauseCounter,
			pausedTimestamp: this.pauseTimestamp,
		}
	}
	pause() {
		this.isPaused = true
		this.pauseTimestamp = Date.now()
		super.pause()
	}
	unpause() {
		super.unpause()
		if (this.isPaused) {
			this.pauseCounter += Date.now() - this.pauseTimestamp
			this.isPaused = false
		}
	}
	/**
	 * 
	 * @param {string} link 
	 */
	addToQueue(link) {
		this.queue.push(link)
	}
}

module.exports = {
	CustomClient,
	CustomAudioPlayer,
}
