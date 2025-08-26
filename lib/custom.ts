import type { AudioResource } from "@discordjs/voice";
import { AudioPlayer, type CreateAudioPlayerOptions } from "@discordjs/voice";
import { Channel, Client, Message, type ClientOptions } from "discord.js";
import { type YouTubeChannel, type YouTubeVideo } from "play-dl";
import { SearchCache } from "./cache";
import { misc } from "./misc";
import { readSetting } from "./setting";
import { createResource, Stream } from "./voice/core";
import { Segment, sendSkipMessage } from "./voice/segment";
import { prefetch } from "./voice/stream";
import { Language } from "./interaction";

const setting = readSetting();

export interface Resource {
	resource: AudioResource<unknown>;
	channel: YouTubeChannel;
	title: string;
	details: YouTubeVideo;
	url: string;
	stream: Stream;
	startFrom?: number;
	segments: Segment[] | null;
}

export interface SongDataPacket {
	song: {
		link: string;
		channel?: string;
		duration: number;
		title?: string;
		thumbnails: string[];
		startFrom: number;
		startTime: number;
	} | null;
	queue: QueueItem[];
	volume: number;
	isPlaying: boolean;
	history: string[];
	useYoutubeDl: boolean;
	canSeek: boolean;
	paused: boolean;
	pausedInMs: number;
	pausedTimestamp: number;
	isMuting: boolean;
	loop: boolean;
	skipToTimestamp: number | null;
}

export interface TokenReturn {
	token: string;
	guilds: string[];
}

export class CustomClient extends Client {
	/**
	 * @description GuildID, AudioPlayer
	 */
	player: Map<string, CustomAudioPlayer>;
	cache: SearchCache;
	private tokenMap: Map<string, string[]>;

	constructor(clientOpt: ClientOptions) {
		super(clientOpt);
		this.player = new Map();
		this.cache = new SearchCache();
		this.tokenMap = new Map();
	}
	clearPlayers() {
		for (const player of this.player.values()) {
			player.clearIntervals();
			player.cleanStop();
		}
		this.player.clear();
		this.tokenMap.clear();
	}

	/**
	 * @private Should not be called by users, use `CustomClient.createToken` instead
	 */
	newToken(guildIds: string[]) {
		const token = misc.generateToken(36);
		this.tokenMap.set(token, guildIds);
		return { token, guildIds };
	}
	createToken(guildIds: string[]): string | null {
		const existingToken = this.getToken(guildIds);
		if (existingToken) return existingToken.token;
		const { token } = this.newToken(guildIds);
		return token;
	}
	appendGuildsByToken(token: string, guildIds: string[]): void {
		const existingToken = this.tokenMap.get(token);
		if (existingToken) {
			this.tokenMap.set(
				token,
				Array.from(new Set([...existingToken, ...guildIds])),
			);
		}
	}
	appendGuilds(guildId: string, guilds: string[]): void {
		const existingToken = this.getToken(guildId);
		if (!existingToken) return;
		this.appendGuildsByToken(existingToken.token, guilds);
	}
	getToken(guildIds: string): TokenReturn | null;
	getToken(guildIds: string[]): TokenReturn | null;
	getToken(guildId: string | string[]): TokenReturn | null {
		const entries = this.tokenMap.entries();
		if (Array.isArray(guildId)) {
			const entry = entries.find(([_, guildIds]) =>
				guildIds.every((id) => guildId.includes(id)),
			);
			if (entry) return { guilds: entry[1], token: entry[0] };
		} else {
			const entry = entries.find(([_, guildIds]) =>
				guildIds.includes(guildId),
			);
			if (entry) return { guilds: entry[1], token: entry[0] };
		}
		return null;
	}
	deleteTokenByGuilds(guilds: string[]) {
		let token = this.getToken(guilds);
		while (token) {
			if (token) {
				this.tokenMap.delete(token.token);
			}
			token = this.getToken(guilds);
		}
	}
	deleteToken(token: string): boolean {
		if (this.tokenMap.has(token)) {
			this.tokenMap.delete(token);
			return true;
		}
		return false;
	}
}

export interface QueueItem {
	url: string;
	repeating: boolean;
}

export interface AudioPlayerSetting {
	autoSkipSegment: boolean;
	looping: boolean;
}

export class CustomAudioPlayer extends AudioPlayer {
	guildId: string;

	volume: number;
	isMuting: boolean;

	/**
	 * @description If the player is playing song (true even when paused)
	 */
	isPlaying: boolean;
	/**
	 * @description Current playing resource or the last played resource
	 */
	nowPlaying: Resource | null;

	/**
	 * @description URL of the music queued
	 */
	queue: QueueItem[];
	/**
	 * @description Distinctive URL of the music played
	 */
	history: string[];

	isPaused: boolean;
	/**
	 * @description Timestamp when the music is paused (or last paused)
	 */
	pauseTimestamp: number;
	/**
	 * @description Sum of time in ms for paused duration (only is accurate when playing, update at unpause)
	 */
	pauseCounter: number;

	/**
	 * @description Time in ms where the music to be started to play
	 */
	startFrom: number;
	/**
	 * @description Timestamp when the music is played
	 */
	startTime: number;

	voiceStateTimeoutArray: NodeJS.Timeout[];
	songSegmentsTimeoutArray: NodeJS.Timeout[];

	channel: Channel | null;

	/**
	 * @description Accumulative counter for music played
	 */
	playCounter: number;
	customSetting: Partial<AudioPlayerSetting>;

	activeSkipMessage: Message | null;
	currentLanguage: Language;

	constructor(
		guildId: string,
		channel: Channel | null = null,
		options?: CreateAudioPlayerOptions,
	) {
		super(options);
		this.guildId = guildId;

		this.volume = 1;
		this.isMuting = false;

		this.isPlaying = false;
		this.nowPlaying = null;

		this.queue = [];
		this.history = [];

		this.startTime = 0;

		this.startFrom = 0;
		this.isPaused = false;

		this.pauseCounter = 0;

		this.pauseTimestamp = 0;
		this.playCounter = 0;

		this.voiceStateTimeoutArray = [];
		this.songSegmentsTimeoutArray = [];
		this.channel = channel;
		this.activeSkipMessage = null;
		this.currentLanguage = Language.English;
		this.customSetting = {};
	}

	setChannel(channel?: Channel | null) {
		this.channel = channel ?? null;
	}

	mute() {
		this.isMuting = true;
		this.nowPlaying?.resource.volume?.setVolume(0);
	}

	unmute() {
		this.isMuting = false;
		this.setVolume(this.volume);
	}

	resetAll() {
		this.stop();
		this.volume = 1;
		this.reset();
	}

	reset() {
		this.pauseCounter = 0;
		this.pauseTimestamp = 0;

		this.queue = [];
		this.history = [];

		this.isPlaying = false;
		this.isPaused = false;
		this.nowPlaying = null;

		this.customSetting = {};

		this.startTime = 0;
		this.startFrom = 0;
	}

	cleanStop() {
		if (this.stop()) {
			this.reset();
			return true;
		}
		return false;
	}

	clearIntervals() {
		for (const id of this.voiceStateTimeoutArray) {
			clearInterval(id);
		}
		this.voiceStateTimeoutArray = [];
	}

	toggleLoop(): boolean {
		if (this.customSetting.looping) {
			this.disableLoop();
			return false;
		} else {
			this.enableLoop();
			return true;
		}
	}

	enableLoop() {
		this.customSetting.looping = true;
		const lastItem = this.queue.at(-1);
		if (
			this.nowPlaying &&
			(!lastItem ||
				(lastItem.url !== this.nowPlaying.url && !lastItem.repeating))
		) {
			this.addToQueue(this.nowPlaying.url, true);
		}
	}
	disableLoop() {
		this.customSetting.looping = false;
		for (let i = 0; i < this.queue.length; i++) {
			if (this.queue[i].repeating) {
				this.queue.splice(i, 1);
				i--;
			}
		}
	}

	getNextQueueItem() {
		if (this.queue.length === 0) return null;
		const item = this.queue.shift();
		if (!item) return null;
		if (item.repeating) {
			this.queue.push({
				repeating: true,
				url: item.url,
			});
		}
		return item.url;
	}

	playResource(resource: Resource, replay = false) {
		if (
			(this.nowPlaying && this.nowPlaying.url !== resource.url) ||
			!this.nowPlaying
		)
			this.playCounter++;
		resource.resource.volume?.setVolume(
			(this.isMuting ? 0 : this.volume) * (setting.VOLUME_MODIFIER ?? 1),
		);
		this.nowPlaying = resource;
		this.isPlaying = true;
		this.isPaused = false;

		this.pauseCounter = 0;
		this.startFrom = resource.startFrom ?? 0;
		this.updateStartTime();
		if (!replay) this.history.push(resource.url);
		this.clearIntervals();
		this.play(resource.resource);

		this.clearSongTimeouts();
		this.updateSongTimeouts();
	}

	setVolume(volume: number) {
		this.volume = volume;
		if (this.isPlaying && this.nowPlaying?.resource && !this.isMuting) {
			this.nowPlaying.resource.volume?.setVolume(
				volume * (setting.VOLUME_MODIFIER ?? 1),
			);
		}
	}

	updateStartTime() {
		this.startTime = Date.now();
	}

	resetPlaying() {
		this.isPlaying = false;
		this.nowPlaying = null;
	}

	getData(): SongDataPacket {
		return {
			song:
				this.isPlaying && this.nowPlaying
					? {
							link: this.nowPlaying.url,
							channel: this.nowPlaying.channel.url,
							duration: this.nowPlaying.details.durationInSec,
							title: this.nowPlaying.details.title,
							thumbnails: this.nowPlaying.details.thumbnails.map(
								(v) => v.url,
							),
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
			canSeek: setting.SEEK,
			loop: this.customSetting.looping ?? false,
			skipToTimestamp: this.currentSegment()?.segment[1] ?? null,
		};
	}
	pause() {
		if (this.isPaused) return false;
		this.isPaused = true;
		this.pauseTimestamp = Date.now();
		super.pause();
		this.updateSongTimeouts();
		return this.isPaused;
	}
	unpause() {
		if (this.isPaused) {
			this.pauseCounter += Date.now() - this.pauseTimestamp;
			this.isPaused = false;
			this.updateSongTimeouts();
		}
		return super.unpause();
	}
	addToQueue(link: string, repeating = false) {
		if (
			setting.USE_YOUTUBE_DL &&
			(this.queue.length > 0 || this.isPlaying)
		) {
			prefetch(link);
		}
		this.queue.push({
			repeating,
			url: link,
		});
	}
	newVoiceStateTimeout(callback: () => void, ms: number) {
		if (ms < 0) return;
		if (ms === 0) return callback();
		const id = setTimeout(callback, ms);
		this.voiceStateTimeoutArray.push(id);
	}
	updateSongTimeouts() {
		const currentPos = this.getCurrentSongPosition();
		if (
			!this.nowPlaying ||
			!this.isPlaying ||
			!this.nowPlaying.segments ||
			!currentPos
		)
			return;
		if (this.isPaused) {
			return this.clearSongTimeouts();
		}
		for (const segment of this.nowPlaying.segments) {
			const [startInSec] = segment.segment;
			const start = startInSec * 1000;
			if (start < currentPos) continue;
			const id = setTimeout(() => {
				if (this.customSetting.autoSkipSegment)
					return this.skipCurrentSegment();
				sendSkipMessage(this);
			}, start - currentPos);
			this.songSegmentsTimeoutArray.push(id);
		}
	}

	currentSegment() {
		const currentPos = this.getCurrentSongPosition();
		if (
			!this.nowPlaying ||
			!this.isPlaying ||
			!this.nowPlaying.segments ||
			!currentPos
		)
			return null;
		for (const segment of this.nowPlaying.segments) {
			const [startInSec, endInSec] = segment.segment;
			const start = startInSec * 1000;
			const end = endInSec * 1000;
			if (currentPos >= start && currentPos <= end) {
				return segment;
			}
		}
		return null;
	}

	async skipCurrentSegment(skipThreshold = 1) {
		const skipTo = this.currentSegment();
		if (!skipTo || !this.nowPlaying) return { success: false };
		if (
			Math.abs(
				this.nowPlaying.details.durationInSec - skipTo.segment[1],
			) <= skipThreshold
		) {
			this.stop();
			return { success: true, skipped: true, skipTo };
		}
		const resource = await createResource(
			this.nowPlaying.url,
			skipTo.segment[1],
		);
		if (!resource) return { success: false };
		this.playResource(resource);
		return { success: true, skipped: false, skipTo };
	}

	clearSongTimeouts() {
		for (const id of this.songSegmentsTimeoutArray) {
			clearTimeout(id);
		}
		this.songSegmentsTimeoutArray = [];
	}

	getCurrentSongPosition() {
		if (!this.isPlaying) return null;
		if (this.isPaused)
			return (
				this.pauseTimestamp -
				this.startTime -
				this.pauseCounter +
				this.startFrom
			);
		return Date.now() - this.startTime - this.pauseCounter + this.startFrom;
	}
}
