import { Client, type ClientOptions } from "discord.js"
import { AudioPlayer, type CreateAudioPlayerOptions } from "@discordjs/voice"
import { SearchCache } from "./cache"
import type { AudioResource } from "@discordjs/voice"
import type { YouTubeChannel, YouTubeVideo } from "play-dl"
import { misc } from './misc'
import { readJsonSync } from './read'

const setting = readJsonSync()

export interface Resource {
	resource: AudioResource<any>,
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

	volume: number
	nowPlaying: Resource | null
	isPlaying: boolean
	queue: string[]
	guildId: string
	isPaused: boolean
	startTime: number
	timeoutList: Timer[]
	pauseCounter: number
	pauseTimestamp: number
	history: string[]
	startFrom: number
	looping: boolean
	isMuting: boolean

	constructor(guildId: string, options?: CreateAudioPlayerOptions) {
		super(options)
		this.guildId = guildId

		this.volume = 1
		this.isMuting = false

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

	mute() {
		this.isMuting = true
		this.nowPlaying?.resource.volume?.setVolume(0)
	}

	unmute() {
		this.isMuting = false
		this.nowPlaying?.resource.volume?.setVolume(this.volume)
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

	playResource(resource: Resource) {
		resource.resource.volume?.setVolume(this.volume)
		this.nowPlaying = resource
		this.isPlaying = true
		this.isPaused = false
		this.pauseCounter = 0
		this.startTime = Date.now()
		this.startFrom = resource.startFrom ?? 0
		resource.resource.volume?.setVolume(this.volume)
		this.play(resource.resource)
	}
	setVolume(volume: number) {
		this.volume = volume
		if (this.isPlaying && this.nowPlaying?.resource && !this.isMuting) {
			this.nowPlaying.resource.volume?.setVolume(volume)
		}
	}
	resetPlaying() {
		this.isPlaying = false
		this.nowPlaying = null
	}


	getData(): SongDataPacket {
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
		super.unpause()
		if (this.isPaused) {
			this.pauseCounter += Date.now() - this.pauseTimestamp
			this.isPaused = false
		}
		return this.isPaused
	}
	addToQueue(link: string) {
		this.queue.push(link)
	}
}
