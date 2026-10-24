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
import { Quality } from "@distube/ytdl-core";
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
import type { Readable } from "node:stream";
import {
	getYouTubeVideoId,
	getYouTubeVideoInfo,
	getYtdl,
	isYouTubePlaylist,
	isYouTubeVideo,
	type YouTubeVideoInfo,
} from "../youtube";
import { CustomAudioPlayer, type CustomClient, type Resource } from "../custom";
import { Language } from "../interaction";
import { dcb, globalApp } from "../misc";
import { event } from "../server/event";
import { readSetting } from "../setting";
import { getSegments, SegmentCategory, sendSkipMessage } from "./segment";
import {
	clipAudio,
	createYtDlpStream,
	decodeToPcm,
	openCacheStream,
	peekWebm,
} from "./stream";
import { VolumeOpusStream, type VolumeControl } from "./volume";
import {
	OpusStream,
	replayWindowPackets,
	streamWindowPackets,
} from "./opusStream";
import { WebmOpusDemuxer } from "./webm";
import { pickRadioTrack } from "./suggest";
import { clampGap, gapBefore } from "./queuePlan";
import { addQueue, allExtraQueues, extraQueues, removeQueue } from "./queues";
import {
	getNativeConnection,
	joinVoiceNative,
	nativeNoCache,
	nativeVoiceActive,
	type NativeConnection,
} from "./native";
import { nativeFetchReady } from "./nativeFetch";
import { updateLastUsed } from "./cache";

const videoInfoCache = new NodeCache();
const setting = readSetting();

/**
 * Either backend's handle on a voice channel.
 *
 * Commands mostly only ask "is the bot in voice?" and "leave", which both
 * paths answer identically, so they do not need to know which one is running.
 */
export type VoiceHandle = VoiceConnection | NativeConnection;

export function disconnectConnection(connection: VoiceHandle) {
	connection.disconnect();
	connection.destroy();
}

function createAudioPlayer(
	guildId: string,
	channel: Channel | null,
	createOpts?: CreateAudioPlayerOptions,
	queueId = 1,
) {
	//create a player and initialize it if there isn't one
	const player = new CustomAudioPlayer(guildId, channel, createOpts, queueId);

	// Nothing arms a leave timer here any more: lib/voice/leave.ts sweeps every
	// player and decides from the state it finds. See leavePlan.ts for why.

	// will be triggered when player unpaused
	player.on(AudioPlayerStatus.Playing, () => {
		if (!player.nowPlaying) return;
		player.isPlaying = true;
	});
	//continue to play song after ending one
	player.on(AudioPlayerStatus.Idle, () => advance(player));
	return player;
}

/**
 * A track ended: move on to the next one, straight away or after the gap
 * before it. The same for every queue a guild has.
 */
async function advance(player: CustomAudioPlayer) {
	const after = player.skipping ? "skip" : "song";
	player.skipping = false;
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
		dcb.log("Finished playing all music");
		return player.endPlayback();
	}
	dcb.log("Finished music playing");
	if (gapBefore(after, player.gapMs, player.queue[0]) > 0) {
		// Silent until the sweep below finds the next song due
		player.endPlayback();
		player.wait = { from: Date.now(), after };
		return;
	}
	await playNext(player);
}

/** Take the head of a queue and play it. */
async function playNext(player: CustomAudioPlayer) {
	try {
		const next = player.shiftQueue();
		const nextUrl = next?.url;
		if (!nextUrl) {
			globalApp.err("No next URL found");
			return player.endPlayback();
		}
		const resource = await createResource(nextUrl, next.seek);
		// The queue may have been dropped while the lookup ran
		if (player.closed) return;
		if (!resource) {
			globalApp.err("Failed to create resource");
			// Moved on from, as a skip would, rather than leaving the queue stuck
			player.endPlayback();
			if (player.queue.length) player.wait = { from: Date.now(), after: "skip" };
			return;
		}
		event.emit("songInfo", nextUrl);
		player.playResource(resource);
		dcb.log(`Playing next music on queue ${player.queueId}`);
		if (resource.segments && player.customSetting.autoSkipSegment) {
			await player.skipCurrentSegment();
			if (!(await sendSkipMessage(player))) {
				globalApp.warn("Failed to send skip message");
			}
		}
	} catch (error) {
		dcb.log(`Error: ${error}`);
		player.endPlayback();
	}
}

/** How often waiting queues are checked for a song that is due. */
const WAIT_SWEEP_MS = 100;
let waitSweeper: ReturnType<typeof setInterval> | null = null;

/**
 * Start the songs queues are waiting on, as their gaps and lead-ins run out.
 *
 * One sweep for every queue of every guild, rather than a timer per wait: a
 * pause, a skip or a dropped queue then only has to change what the queue
 * waits on, and no timer is ever left to fire into a queue that has gone.
 */
export function bindQueueWaits(client: CustomClient) {
	if (waitSweeper) return;
	waitSweeper = setInterval(() => {
		const now = Date.now();
		for (const player of [...client.player.values(), ...allExtraQueues()]) {
			if (!player.isDue(now)) continue;
			player.wait = null;
			void playNext(player);
		}
	}, WAIT_SWEEP_MS);
	waitSweeper.unref?.();
}

export interface QueueOptions {
	/** Linear, 1 is as recorded. */
	volume?: number;
	gapMs?: number;
	loop?: boolean;
}

/**
 * Open another queue for the guild, mixed in over the others. Only the
 * sidecar can play two things at once, so this is null without it, and when
 * the guild already has as many queues as it may.
 */
export function createQueue(
	guildId: string,
	channel: Channel | null,
	{ volume, gapMs, loop }: QueueOptions = {},
) {
	if (!nativeVoiceActive()) return null;
	return addQueue(guildId, (n) => {
		const player = createAudioPlayer(guildId, channel, {}, n);
		if (gapMs !== undefined) player.gapMs = clampGap(gapMs);
		if (loop) player.customSetting.looping = true;
		player.setVolume(volume ?? 1);
		return player;
	});
}

/** Drop one of the guild's queues past the first. */
export function closeQueue(player: CustomAudioPlayer) {
	if (removeQueue(player)) player.close();
}

/**
 * Pause every queue the guild has, as a pause that names no queue does.
 * True when queue 1 paused, or any other that was playing or waiting did.
 */
export function pauseAll(main: CustomAudioPlayer) {
	let paused = main.pause();
	for (const queue of extraQueues(main.guildId)) {
		if ((queue.isPlaying || queue.wait) && queue.pause()) paused = true;
	}
	return paused;
}

/** Undo `pauseAll`. True when any queue was paused. */
export function unpauseAll(main: CustomAudioPlayer) {
	let resumed = main.unpause();
	for (const queue of extraQueues(main.guildId)) {
		if (queue.isPaused && queue.unpause()) resumed = true;
	}
	return resumed;
}

/** Every queue the guild has, queue 1 first. */
export function guildQueues(client: CustomClient, guildId: string): CustomAudioPlayer[] {
	const main = client.player.get(guildId);
	return [...(main ? [main] : []), ...extraQueues(guildId)];
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
		const player = createAudioPlayer(guildId, channel, {});
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

export function getConnection(guildId: string | null): VoiceHandle | undefined {
	if (!guildId) return;
	// Checked first so a guild joined natively is not reported as absent just
	// because @discordjs/voice has never heard of it.
	return getNativeConnection(guildId) ?? getVoiceConnection(guildId);
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
	const source = getYtdl().download(url, {
		filter: { hasAudio: true, hasVideo: false },
		quality: Quality.HighestAudio,
	});
	// v5 only seeks SABR formats (startTimeMs throws on any format with a
	// URL), so seek through ffmpeg as the yt-dlp path does
	if (seek && seek > 0) {
		return { stream: clipAudio(source, seek).copied, type: StreamType.Arbitrary };
	}
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
	const videoInfo = await getYouTubeVideoInfo(url);
	videoInfoCache.set(id, videoInfo);
	return videoInfo;
}

/**
 * The metadata half of a resource, for playback that happens elsewhere.
 *
 * The sidecar reads the cache file itself, so there is no stream to build, no
 * demuxer to run and no buffer to hold here — only the track's details, the
 * segments, and the cache id it should be asked to play. What this does do is
 * make sure the file exists first, unless caching is off: then the sidecar
 * downloads the track itself, and nothing touches the cache.
 */
async function createNativeResource(
	url: string,
	detail: YouTubeVideoInfo["video_details"],
	seek?: number,
	skipCache = false,
): Promise<Resource | null> {
	const id = getYouTubeVideoId(url);
	if (!id) return null;
	if (!nativeNoCache()) {
		await nativeFetchReady(id, skipCache);
		await updateLastUsed([id]);
	}

	const segments = await getSegments(id, [SegmentCategory.MusicOffTopic]);
	if (!detail.channel || !detail.title) {
		throw new Error(
			"Resource could not be created due to channel and title missing",
		);
	}
	return {
		videoId: id,
		channel: detail.channel,
		title: detail.title,
		details: detail,
		segments,
		url,
		startFrom: (seek ?? 0) * 1000,
	};
}

export async function createResource(
	url: string,
	seek?: number,
	skipCache = false,
): Promise<Resource | null> {
	const detail = (await getVideoInfo(url))?.video_details;
	if (!detail || (detail.id && setting.BANNED_IDS.includes(detail.id)))
		return null;
	if (nativeVoiceActive()) return createNativeResource(url, detail, seek, skipCache);
	// WebM/Opus goes through our own demuxer, which skips ffmpeg entirely: the
	// packets in the container are already the 20ms Opus frames Discord wants.
	// Anything else (rare, but yt-dlp does occasionally hand back AAC) keeps
	// the ffmpeg decode path.
	const id = getYouTubeVideoId(url);
	// Seek is applied per branch below, so the source is always unclipped here
	const raw = await createStream(url, undefined, skipCache);
	const { isWebm, stream } = await peekWebm(raw.stream);

	let volume: VolumeControl & Readable;
	if (isWebm) {
		const demuxer = new WebmOpusDemuxer();
		stream.pipe(demuxer);
		const opus = new OpusStream(demuxer, {
			playedWindow: replayWindowPackets(setting.MAX_REPLAY_BUFFER_IN_SEC),
			aheadWindow: streamWindowPackets(setting.MAX_STREAM_BUFFER_IN_MB),
			// follow=true so a livestream keeps reading as the file grows
			openCache: id ? () => openCacheStream(id, true) : undefined,
		});
		// Seeking is an anchor move, so no second ffmpeg pass and no re-read
		if (seek && seek > 0) opus.relocate(seek * 1000);
		volume = opus;
	} else {
		globalApp.warn(`Not WebM, falling back to ffmpeg decode: ${url}`);
		const seeked =
			seek && seek > 0 ? clipAudio(stream, seek).copied : stream;
		const { stream: pcm, kill } = decodeToPcm(seeked);
		// Gain is applied by our own encoder instead of inlineVolume so that a
		// volume change is not stuck behind the buffered, already-scaled audio
		// of the built-in pipeline
		volume = new VolumeOpusStream(pcm, { onClose: kill });
	}

	const res = createAudioResource(volume, {
		inputType: StreamType.Opus,
		inlineVolume: false,
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
		volume,
		stream: raw,
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
): VoiceHandle {
	if (nativeVoiceActive()) return joinVoiceNative(voiceChannel);
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
