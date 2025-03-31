import {
	createAudioResource,
	AudioPlayerStatus,
	joinVoiceChannel,
	getVoiceConnection,
	StreamType,
	type CreateAudioPlayerOptions,
	type VoiceConnection,
	type DiscordGatewayAdapterCreator,
} from "@discordjs/voice"
import {
	extractID,
	type InfoData,
	stream,
	video_info,
	yt_validate,
} from "play-dl"
import ytdl from '@distube/ytdl-core'
import { CustomAudioPlayer, type Resource, type CustomClient } from "../custom"
import { dcb, globalApp } from "../misc"
import { event } from "../express/event"
import NodeCache from "node-cache"
import { readSetting } from "../read"
import dotenv from 'dotenv'
import fs from 'node:fs'
import type { APIInteractionGuildMember, CacheType, CommandInteraction, GuildMember, VoiceBasedChannel, VoiceChannel } from "discord.js"
import { recordingList, startRecord, stopRecord } from "./record"
import { createYtDlpStream } from "./stream"
import type { Readable } from "node:stream"
dotenv.config()

const videoInfoCache = new NodeCache()
const setting = readSetting()
let agent: ytdl.Agent | undefined = undefined

try {
	const cookies = JSON.parse(fs.readFileSync("cookies.json", 'utf8'))
	if (cookies && setting.USE_COOKIES) {
		agent = ytdl.createAgent(cookies)
	}
} catch {
	globalApp.warn("No cookies found")
}

export function disconnectConnection(connection: VoiceConnection, guildId: string) {
	connection.disconnect()
	connection.destroy()
	stopRecord(guildId)
	recordingList.delete(guildId)
}

export function createAudioPlayer(guildId: string, client: CustomClient, createOpts?: CreateAudioPlayerOptions) {
	//create a player and initialize it if there isn't one
	const player = new CustomAudioPlayer(guildId, createOpts)

	const timeoutDetection = () => {
		if (player.isPlaying || player.queue.length > 0) {
			return
		}
		dcb.log(`Auto quitted for inactivity (${player.isPlaying ? 'Y' : 'N'}_${player.queue.length})`)
		player.cleanStop()
		const connection = getVoiceConnection(guildId)
		destroyAudioPlayer(client, guildId)
		if (connection) {
			disconnectConnection(connection, guildId)
		}
		client.player.delete(guildId)
	}

	player.newTimeout(timeoutDetection, setting.AUTO_LEAVE ?? 15 * 60 * 1000)

	// will be triggered when player unpaused
	player.on(AudioPlayerStatus.Playing, () => {
		if (!player.nowPlaying?.url) return
		player.isPlaying = true
	})
	//continue to play song after ending one
	player.on(AudioPlayerStatus.Idle, async () => {
		if (!player) {
			return
		}
		if (player.queue.length === 0) {
			player.newTimeout(timeoutDetection, setting.AUTO_LEAVE ?? 15 * 60 * 1000)
		}

		try {
			dcb.log("Finished music playing")
			if (player.queue.length > 0) {
				player.clearIntervals()
				const nextUrl = player.getNextQueueItem()
				if (nextUrl) {
					const resource = await createResource(nextUrl)
					if (!resource) {
						return globalApp.err('Failed to create resource')
					}
					event.emit("songInfo", nextUrl)
					player.playResource(resource)
					dcb.log("Playing next music")
				} else {
					globalApp.err('No next URL found')
				}
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

interface GetAudioPlayerOption { createPlayer: boolean }

export function getAudioPlayer(
	client: CustomClient,
	interaction: CommandInteraction,
	option: GetAudioPlayerOption = { createPlayer: true },
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

export function destroyAudioPlayer(client: CustomClient, guildId: string): boolean {
	if (client.player.has(guildId)) {
		// reset player to the init status
		client.player.get(guildId)?.resetAll()
		client.deleteTokenByGuilds([guildId])
		client.player.delete(guildId)
		return true
	}
	return false
}

export function getConnection(guildId: string | null) {
	if (!guildId) return
	return getVoiceConnection(guildId)
}

export interface Stream { stream: Readable, type: StreamType }

export async function createStream(url: string, seek?: number): Promise<Stream> {
	if (setting.USE_YOUTUBE_DL) {
		const stream = await createYtDlpStream(url, seek)
		// const stream = ytdl(url, { filter: 'audioonly', quality: 'highestaudio', begin: seek, agent })
		return { stream, type: StreamType.Arbitrary }
	}
	const source = await stream(url, { seek })
	return { stream: source.stream, type: source.type as StreamType }
}

export async function getVideoInfo(url: string): Promise<InfoData | null> {
	if (!isYoutube(url)) return null
	const id = extractID(url)
	if (videoInfoCache.get(id)) {
		return videoInfoCache.get(id) as InfoData
	}
	const videoInfo = await video_info(id)
	videoInfoCache.set(id, videoInfo)
	return videoInfo
}

export async function createResource(url: string, seek?: number): Promise<Resource | null> {
	const detail = (await getVideoInfo(url))?.video_details
	if (!detail || detail.id && setting.BANNED_IDS.includes(detail.id)) return null
	const source = await createStream(url, seek)
	const res = createAudioResource(source.stream, {
		inputType: source.type as StreamType,
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
		startFrom: (seek ?? 0) * 1000
	}
}

export function ensureVoiceConnection(interaction: CommandInteraction<CacheType>) {
	const connection = getConnection(interaction.guildId)
	if (!connection) {
		if (!interaction.member || !isGuildMember(interaction.member) || !interaction.member.voice.channel) return null
		return joinVoice(interaction.member.voice.channel, interaction)
	}
	return connection
}


export function isGuildMember(member: GuildMember | APIInteractionGuildMember): member is GuildMember {
	return 'voice' in member
}

export function joinVoice(voiceChannel: VoiceChannel | VoiceBasedChannel, interaction: CommandInteraction, record = true) {
	if (!interaction.guild) {
		return
	}
	const connection = joinVoiceChannel({
		channelId: voiceChannel.id,
		guildId: voiceChannel.guildId,
		adapterCreator: interaction.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
		selfDeaf: false,
		selfMute: false,
	})
	if (record) {
		dcb.log('Recording started')
		startRecord(interaction)
	}
	return connection
}

export function isYoutube(query: string) {
	return yt_validate(query) !== false
}

export function isVideo(link: string) {
	return yt_validate(link) === "video"
}

export function isPlaylist(link: string) {
	return yt_validate(link) === "playlist"
}

// https://stackoverflow.com/questions/3733227/javascript-seconds-to-minutes-and-seconds
export function timeFormat(duration: string | number) {
	const dur = typeof duration === 'number' ? duration : Number.parseInt(duration)
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

export interface TransformableResource {
	details: {
		durationInSec: number
	},
	title: string,
	url: string
}

export function songToString(d: TransformableResource, i?: number) {
	return `${i ? `\`${i}.\` ` : ""}${d.title}(${d.url}) \`${timeFormat(
		d.details.durationInSec,
	)}\``
}
