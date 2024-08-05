import { Client, type ClientOptions } from "discord.js"
import { AudioPlayer, type CreateAudioPlayerOptions } from "@discordjs/voice"
import { SearchCache } from "./cache"
import type { AudioResource } from "@discordjs/voice"
import type { YouTubeChannel, YouTubeVideo } from "play-dl"
import { misc } from './misc'
import { readJsonSync } from './read'

const setting = readJsonSync()

export interface Resource {
	resource: AudioResource<unknown>,
	channel: YouTubeChannel,
	title: string,
	details: YouTubeVideo,
	url: string,
	startFrom?: number
}

interface Token {
	token: string,
	guilds: string[],
	level: number
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
	queue: string[],
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

export class CustomClient extends Client {
	/**
	 * @description GuildID, AudioPlayer
	*/
	player: Map<string, CustomAudioPlayer>
	cache: SearchCache
	levelMap: Map<string, { guilds: string[], level: number }>
	savedLevelMap: Map<string, string>

	constructor(clientOpt: ClientOptions) {
		super(clientOpt)
		this.player = new Map()
		this.cache = new SearchCache()
		this.levelMap = new Map()
		this.savedLevelMap = new Map()
	}
	newToken(guildId: string): Token {
		const token = misc.generateToken(36)
		const level = 1
		this.levelMap.set(token, { guilds: [guildId], level })
		return { token, guilds: [guildId], level }
	}
	createToken(guildId: string): string | null {
		if (this.savedLevelMap.has(guildId)) {
			return this.savedLevelMap.get(guildId) ?? null
		}
		const { token } = this.newToken(guildId)
		this.savedLevelMap.set(guildId, token)
		return token
	}
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
	queue: string[]
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

	/**
	 * @todo Implement looping
	 */
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
			clearInterval(id)
		}
		this.timeoutList = []
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
		this.queue.push(link)
	}
	newTimeout(callback: () => void, ms: number) {
		if (ms < 0) return
		if (ms === 0) return callback()
		const id = setTimeout(callback, ms)
		this.timeoutList.push(id)
	}
}
