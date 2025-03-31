import { Client, type ClientOptions } from "discord.js"
import { AudioPlayer, type CreateAudioPlayerOptions } from "@discordjs/voice"
import { SearchCache } from "./cache"
import type { AudioResource } from "@discordjs/voice"
import type { YouTubeChannel, YouTubeVideo } from "play-dl"
import { misc } from './misc'
import { readSetting } from './read'

const setting = readSetting()

export interface Resource {
	resource: AudioResource<unknown>,
	channel: YouTubeChannel,
	title: string,
	details: YouTubeVideo,
	url: string,
	startFrom?: number
}

export interface SongDataPacket {
	song: {
		link: string,
		channel?: string,
		duration: number,
		title?: string,
		thumbnails: string[],
		startFrom: number,
		startTime: number
	} | null,
	queue: QueueItem[],
	volume: number,
	isPlaying: boolean,
	history: string[],
	useYoutubeDl: boolean,
	canSeek: boolean,
	paused: boolean,
	pausedInMs: number,
	pausedTimestamp: number,
	isMuting: boolean
}

export interface TokenReturn {
	token: string,
	guilds: string[]
}

export class CustomClient extends Client {
	/**
	 * @description GuildID, AudioPlayer
	*/
	player: Map<string, CustomAudioPlayer>
	cache: SearchCache
	private tokenMap: Map<string, string[]>
	record: Set<string>

	constructor(clientOpt: ClientOptions) {
		super(clientOpt)
		this.player = new Map()
		this.cache = new SearchCache()
		this.tokenMap = new Map()
		this.record = new Set()
	}
	/**
	 * @private Should not be called by users, use `CustomClient.createToken` instead
	 */
	newToken(guildIds: string[]) {
		const token = misc.generateToken(36)
		this.tokenMap.set(token, guildIds)
		return { token, guildIds }
	}
	createToken(guildIds: string[]): string | null {
		const existingToken = this.getToken(guildIds)
		if (existingToken) return existingToken.token
		const { token } = this.newToken(guildIds)
		return token
	}
	appendGuildsByToken(token: string, guildIds: string[]): void {
		const existingToken = this.tokenMap.get(token)
		if (existingToken) {
			this.tokenMap.set(token, Array.from(new Set([...existingToken, ...guildIds])))
		}
	}
	appendGuilds(guildId: string, guilds: string[]): void {
		const existingToken = this.getToken(guildId)
		if (!existingToken) return
		this.appendGuildsByToken(existingToken.token, guilds)
	}
	getToken(guildIds: string): TokenReturn | null
	getToken(guildIds: string[]): TokenReturn | null
	getToken(guildId: string | string[]): TokenReturn | null {
		const entries = this.tokenMap.entries()
		if (Array.isArray(guildId)) {
			const entry = entries.find(([_, guildIds]) => guildIds.every(id => guildId.includes(id)))
			if (entry) return { guilds: entry[1], token: entry[0] }
		} else {
			const entry = entries.find(([_, guildIds]) => guildIds.includes(guildId))
			if (entry) return { guilds: entry[1], token: entry[0] }
		}
		return null
	}
	deleteTokenByGuilds(guilds: string[]) {
		let token = this.getToken(guilds)
		while (token) {
			if (token) {
				this.tokenMap.delete(token.token)
			}
			token = this.getToken(guilds)
		}
	}
	deleteToken(token: string): boolean {
		if (this.tokenMap.has(token)) {
			this.tokenMap.delete(token)
			return true
		}
		return false
	}
}

export interface QueueItem {
	url: string,
	repeating: boolean
}

export class CustomAudioPlayer extends AudioPlayer {

	guildId: string

	volume: number
	isMuting: boolean

	isPlaying: boolean
	/**
	 * @description Current playing resource or the last played resource
	 */
	nowPlaying: Resource | null

	/**
	 * @description URL of the music queued
	 */
	queue: QueueItem[]
	/**
	 * @description Distinctive URL of the music played
	 */
	history: string[]

	isPaused: boolean
	/**
	 * @description Timestamp when the music is paused
	 */
	pauseTimestamp: number
	/**
	 * @description Time in ms where the music is paused
	 */
	pauseCounter: number

	/**
	 * @description Time in ms where the music to be started to play
	 */
	startFrom: number
	/**
	 * @description Timestamp when the music is played
	 */
	startTime: number

	timeoutList: Timer[]

	looping: boolean

	constructor(guildId: string, options?: CreateAudioPlayerOptions) {
		super(options)
		this.guildId = guildId

		this.volume = 1
		this.isMuting = false


		this.isPlaying = false
		this.nowPlaying = null

		this.queue = []
		this.history = []


		this.startTime = 0

		this.startFrom = 0
		this.isPaused = false

		this.pauseCounter = 0

		this.pauseTimestamp = 0

		this.looping = false

		this.timeoutList = []
	}

	mute() {
		this.isMuting = true
		this.nowPlaying?.resource.volume?.setVolume(0)
	}

	unmute() {
		this.isMuting = false
		this.setVolume(this.volume)
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
		this.history = []

		this.isPlaying = false
		this.isPaused = false
		this.nowPlaying = null

		this.looping = false

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
			clearInterval(id)
		}
		this.timeoutList = []
	}

	enableLoop() {
		this.looping = true
	}
	disableLoop() {
		this.looping = false
		for (let i = 0; i < this.queue.length; i++) {
			if (this.queue[i].repeating) {
				this.queue.splice(i, 1)
				i--
			}
		}
	}

	getNextQueueItem() {
		if (this.queue.length === 0) return null
		const item = this.queue.shift()
		if (!item) return null
		if (item.repeating) {
			this.queue.push({
				repeating: true,
				url: item.url
			})
		}
		return item.url
	}


	playResource(resource: Resource) {
		resource.resource.volume?.setVolume((this.isMuting ? 0 : this.volume) * (setting.VOLUME_MODIFIER ?? 1))
		this.nowPlaying = resource
		this.isPlaying = true
		this.isPaused = false

		this.pauseCounter = 0
		this.startFrom = resource.startFrom ?? 0
		this.updateStartTime()
		this.history.push(resource.url)
		this.clearIntervals()
		this.play(resource.resource)
	}

	setVolume(volume: number) {
		this.volume = volume
		if (this.isPlaying && this.nowPlaying?.resource && !this.isMuting) {
			this.nowPlaying.resource.volume?.setVolume(volume * (setting.VOLUME_MODIFIER ?? 1))
		}
	}

	updateStartTime() {
		this.startTime = Date.now()
	}

	resetPlaying() {
		this.isPlaying = false
		this.nowPlaying = null
	}


	getData(): SongDataPacket {
		return {
			song: this.isPlaying && this.nowPlaying
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
			isMuting: this.isMuting,
			paused: this.isPaused,
			pausedInMs: this.pauseCounter,
			pausedTimestamp: this.pauseTimestamp,
			useYoutubeDl: setting.USE_YOUTUBE_DL,
			canSeek: setting.SEEK
		}
	}
	pause() {
		this.isPaused = true
		this.pauseTimestamp = Date.now()
		super.pause()
		return this.isPaused
	}
	unpause() {
		if (this.isPaused) {
			this.pauseCounter += Date.now() - this.pauseTimestamp
			this.isPaused = false
		}
		return super.unpause()
	}
	addToQueue(link: string) {
		this.queue.push({
			repeating: false,
			url: link
		})
	}
	newTimeout(callback: () => void, ms: number) {
		if (ms < 0) return
		if (ms === 0) return callback()
		const id = setTimeout(callback, ms)
		this.timeoutList.push(id)
	}
}
