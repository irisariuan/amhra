import {
    AudioPlayerStatus,
    createAudioResource,
    entersState,
    getVoiceConnection,
    joinVoiceChannel,
    StreamType,
    VoiceConnectionStatus,
    type CreateAudioPlayerOptions,
    type DiscordGatewayAdapterCreator,
    type VoiceConnection,
} from "@discordjs/voice";
import ytdl from "@distube/ytdl-core";
import {
    Guild,
    type APIInteractionGuildMember,
    type CacheType,
    type Channel,
    type CommandInteraction,
    type GuildMember,
    type VoiceBasedChannel,
    type VoiceChannel,
} from "discord.js";
import "dotenv/config";
import NodeCache from "node-cache";
import fs from "node:fs";
import type { Readable } from "node:stream";
import {
	getYouTubeVideoId,
	getYouTubeVideoInfo,
	isYouTubePlaylist,
	isYouTubeUrl,
	isYouTubeVideo,
	type YouTubeVideoInfo,
} from "../youtube";
import { CustomAudioPlayer, type CustomClient, type Resource } from "../custom";
import { Language } from "../interaction";
import { dcb, globalApp } from "../misc";
import { event } from "../server/event";
import { readSetting } from "../setting";
import { getSegments, SegmentCategory, sendSkipMessage } from "./segment";
import { clipAudio, createYtDlpStream } from "./stream";
import { pickRadioTrack } from "./suggest";

const videoInfoCache = new NodeCache();
const setting = readSetting();
let agent: ytdl.Agent | undefined = undefined;

try {
	const cookies = JSON.parse(fs.readFileSync("cookies.json", "utf8"));
	if (cookies && setting.USE_COOKIES) {
		agent = ytdl.createAgent(cookies);
	}
} catch {
	globalApp.warn("No cookies found");
}

export function disconnectConnection(connection: VoiceConnection) {
	connection.disconnect();
	connection.destroy();
}

function createAudioPlayer(
	guildId: string,
	channel: Channel | null,
	client: CustomClient,
	createOpts?: CreateAudioPlayerOptions,
) {
	//create a player and initialize it if there isn't one
	const player = new CustomAudioPlayer(guildId, channel, createOpts);

	const timeoutDetection = () => {
		if (player.isPlaying || player.queue.length > 0) {
			return;
		}
		dcb.log(
			`Auto quitted for inactivity (${player.isPlaying ? "Y" : "N"}_${player.queue.length})`,
		);
		player.cleanStop();
		const connection = getVoiceConnection(guildId);
		destroyAudioPlayer(client, guildId);
		if (connection) {
			disconnectConnection(connection);
		}
		client.player.delete(guildId);
	};

	player.newVoiceStateTimeout(
		timeoutDetection,
		setting.AUTO_LEAVE ?? 15 * 60 * 1000,
	);

	// will be triggered when player unpaused
	player.on(AudioPlayerStatus.Playing, () => {
		if (!player.nowPlaying) return;
		player.isPlaying = true;
	});
	//continue to play song after ending one
	player.on(AudioPlayerStatus.Idle, async () => {
		// Radio mode: when the queue empties, auto-append a related track so
		// playback continues, unless the account disabled it.
		if (
			player.queue.length === 0 &&
			player.customSetting.autoSuggest &&
			player.nowPlaying
		) {
			const next = await pickRadioTrack(
				player.nowPlaying.url,
				player.history,
			).catch(() => null);
			if (next) {
				player.addToQueue(next);
				dcb.log("Radio mode queued a suggested track");
			}
		}
		if (player.queue.length === 0) {
			player.newVoiceStateTimeout(
				timeoutDetection,
				setting.AUTO_LEAVE ?? 15 * 60 * 1000,
			);
		}

		try {
			dcb.log("Finished music playing");
			if (player.queue.length > 0) {
				player.clearVoiceStateTimeouts();
				const nextUrl = player.getNextQueueItem();
				if (nextUrl) {
					const resource = await createResource(nextUrl);
					if (!resource) {
						return globalApp.err("Failed to create resource");
					}
					event.emit("songInfo", nextUrl);
					player.playResource(resource);
					dcb.log("Playing next music");
					if (resource.segments) {
						if (player.customSetting.autoSkipSegment) {
							return await player.skipCurrentSegment();
						}
						if (!(await sendSkipMessage(player))) {
							globalApp.warn("Failed to send skip message");
						}
					}
				} else {
					globalApp.err("No next URL found");
					player.newVoiceStateTimeout(
						timeoutDetection,
						setting.AUTO_LEAVE ?? 15 * 60 * 1000,
					);
				}
			} else {
				player.resetPlaying();
				dcb.log("Finished playing all music");
				player.cleanStop();
				player.newVoiceStateTimeout(
					timeoutDetection,
					setting.AUTO_LEAVE ?? 15 * 60 * 1000,
				);
			}
		} catch (error) {
			dcb.log(`Error: ${error}`);
			player.resetPlaying();
			player.newVoiceStateTimeout(
				timeoutDetection,
				setting.AUTO_LEAVE ?? 15 * 60 * 1000,
			);
		}
	});
	return player;
}

interface GetAudioPlayerOption {
	createPlayer: boolean;
}

export function getAudioPlayer(
	client: CustomClient,
	guildId: string,
	channel: Channel | null,
	language: Language,
	option: GetAudioPlayerOption = { createPlayer: true },
) {
	const player = client.player.get(guildId) ?? null;

	if (!player && option.createPlayer) {
		const player = createAudioPlayer(guildId, channel, client, {});
		client.player.set(guildId, player);
		return player;
	}
	if (channel) player?.setChannel(channel);
	if (player && player.currentLanguage !== language) {
		player.currentLanguage = language;
	}
	return player;
}

export function destroyAudioPlayer(
	client: CustomClient,
	guildId: string,
): boolean {
	if (client.player.has(guildId)) {
		// reset player to the init status
		client.player.get(guildId)?.resetAll();
		client.player.delete(guildId);
		return true;
	}
	return false;
}

export function getConnection(guildId: string | null) {
	if (!guildId) return;
	return getVoiceConnection(guildId);
}

export interface Stream {
	stream: Readable;
	type: StreamType;
}

export async function createStream(
	url: string,
	seek?: number,
	skipCache = false,
): Promise<Stream> {
	if (setting.USE_YOUTUBE_DL) {
		const stream = await createYtDlpStream(url, skipCache);
		if (seek && seek > 0) {
			const { copied, proc } = clipAudio(stream, seek);
			copied.once("end", () => {
				if (proc.exitCode === null) {
					dcb.log(`Seek quitted early, killing process`);
					// proc.kill();
				}
			});
			return {
				stream: copied,
				type: StreamType.Arbitrary,
			};
		}
		// const stream = ytdl(url, { filter: 'audioonly', quality: 'highestaudio', begin: seek, agent })
		return { stream, type: StreamType.Arbitrary };
	}
	const source = ytdl(url, {
		filter: "audioonly",
		quality: "highestaudio",
		...(seek && seek > 0 ? { begin: seek } : {}),
		agent,
	});
	return { stream: source, type: StreamType.Arbitrary };
}

export async function getVideoInfo(
	url: string,
): Promise<YouTubeVideoInfo | null> {
	if (!isVideo(url)) return null;
	const id = getYouTubeVideoId(url);
	if (!id) return null;
	if (videoInfoCache.get(id)) {
		return videoInfoCache.get(id) as YouTubeVideoInfo;
	}
	const videoInfo = await getYouTubeVideoInfo(url, agent);
	videoInfoCache.set(id, videoInfo);
	return videoInfo;
}

export async function createResource(
	url: string,
	seek?: number,
	skipCache = false,
): Promise<Resource | null> {
	const detail = (await getVideoInfo(url))?.video_details;
	if (!detail || (detail.id && setting.BANNED_IDS.includes(detail.id)))
		return null;
	const source = await createStream(url, seek, skipCache);
	const res = createAudioResource(source.stream, {
		inputType: source.type as StreamType,
		inlineVolume: true,
	});
	const segments = await getSegments(getYouTubeVideoId(url) ?? "", [
		SegmentCategory.MusicOffTopic,
	]);
	if (!detail.channel || !detail.title) {
		throw new Error(
			"Resource could not be created due to channel and title missing",
		);
	}
	return {
		resource: res,
		stream: source,
		channel: detail.channel,
		title: detail.title,
		details: detail,
		segments,
		url,
		startFrom: (seek ?? 0) * 1000,
	};
}

export function ensureVoiceConnection(
	interaction: CommandInteraction<CacheType>,
) {
	const connection = getConnection(interaction.guildId);
	if (!connection) {
		if (
			!interaction.member ||
			!isGuildMember(interaction.member) ||
			!interaction.member.voice.channel ||
			!interaction.guild
		)
			return null;
		return joinVoice(interaction.member.voice.channel, interaction.guild);
	}
	return connection;
}

export function isGuildMember(
	member: GuildMember | APIInteractionGuildMember,
): member is GuildMember {
	return "voice" in member;
}

export function joinVoice(
	voiceChannel: VoiceChannel | VoiceBasedChannel,
	guild: Guild,
	record = true,
) {
	const connection = joinVoiceChannel({
		channelId: voiceChannel.id,
		guildId: voiceChannel.guildId,
		adapterCreator:
			guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
		selfDeaf: false,
		selfMute: false,
	});
	connection.on(VoiceConnectionStatus.Disconnected, async () => {
		try {
			await Promise.race([
				entersState(
					connection,
					VoiceConnectionStatus.Signalling,
					5_000,
				),
				entersState(
					connection,
					VoiceConnectionStatus.Connecting,
					5_000,
				),
			]);
			// Seems to be reconnecting to a new channel - ignore disconnect
		} catch {
			// Seems to be a real disconnect which SHOULDN'T be recovered from
			try {
				connection.destroy();
			} catch {
				globalApp.err(
					"[Auto Disconnection] Failed to destroy connection",
				);
			}
		}
	});
	if (record) {
		dcb.log("Recording started");
		// startRecord(interaction)
	}
	return connection;
}

export function getBotVoiceChannel(
	guild: Guild,
	client: CustomClient,
): VoiceChannel | undefined {
	return guild.channels.cache.find((channel): channel is VoiceChannel => {
		return !!(
			channel.isVoiceBased() &&
			client.user &&
			channel.members.has(client.user.id)
		);
	});
}

export function isYoutube(query: string) {
	return isYouTubeUrl(query);
}

export function isVideo(link: string) {
	return isYouTubeVideo(link);
}

export function isPlaylist(link: string) {
	return isYouTubePlaylist(link);
}

// https://stackoverflow.com/questions/3733227/javascript-seconds-to-minutes-and-seconds
export function timeFormat(duration: string | number) {
	const dur =
		typeof duration === "number" ? duration : Number.parseInt(duration);
	// Hours, minutes and seconds
	// ~~ = Math.floor for positive numbers with better performance
	const hrs = ~~(dur / 3600);
	const mins = ~~((dur % 3600) / 60);
	const secs = ~~dur % 60;

	// Output like "1:01" or "4:03:59" or "123:03:59"
	let result = "";

	if (hrs > 0) {
		result += `${hrs}:${mins < 10 ? "0" : ""}`;
	}

	result += `${mins}:${secs < 10 ? "0" : ""}`;
	result += `${secs}`;

	return result;
}

export interface TransformableResource {
	details: {
		durationInSec: number;
	};
	title: string;
	url: string;
}

export function songToString(
	d: TransformableResource,
	i?: number,
	currentPos?: number,
) {
	return `${i ? `\`${i}.\` ` : ""}${d.title}(${d.url})${
		currentPos === undefined ? " " : `\n\`${timeFormat(currentPos)}\`/`
	}\`${timeFormat(d.details.durationInSec)}\``;
}
