import { Channel, Client, type ClientOptions } from "discord.js";
import { AudioPlayer, type CreateAudioPlayerOptions } from "@discordjs/voice";
import { SearchCache } from "./cache";
import type { AudioResource } from "@discordjs/voice";
import type { YouTubeChannel, YouTubeVideo } from "play-dl";
import { dcb, misc } from "./misc";
import { readSetting } from "./setting";
import { prefetch } from "./voice/stream";
import { createResource, Stream, timeFormat } from "./voice/core";
import { Segment, SegmentCategory } from "./voice/segment";

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
	record: Set<string>;

	constructor(clientOpt: ClientOptions) {
		super(clientOpt);
		this.player = new Map();
		this.cache = new SearchCache();
		this.tokenMap = new Map();
		this.record = new Set();
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

	looping: boolean;

	/**
	 * @description Accumulative counter for music played
	 */
	playCounter: number;

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

		this.looping = false;
		this.playCounter = 0;

		this.voiceStateTimeoutArray = [];
		this.songSegmentsTimeoutArray = [];
		this.channel = channel;
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

		this.looping = false;

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

	enableLoop() {
		this.looping = true;
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
		this.looping = false;
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
		resource.resource.volume?.setVolume(
			(this.isMuting ? 0 : this.volume) * (setting.VOLUME_MODIFIER ?? 1),
		);
		this.nowPlaying = resource;
		this.isPlaying = true;
		this.isPaused = false;

		this.playCounter++;
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
			loop: this.looping,
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
		dcb.log(`Updating song timeouts at ${currentPos}`);
		for (const segment of this.nowPlaying.segments) {
			const [startInSec] = segment.segment;
			const start = startInSec * 1000;
			if (start < currentPos) continue;
			const id = setTimeout(() => {
				dcb.log("Sending skip message");
				this.sendSkipMessage(segment);
			}, start - currentPos);
			this.songSegmentsTimeoutArray.push(id);
		}
	}

	clearSongTimeouts() {
		for (const id of this.songSegmentsTimeoutArray) {
			clearTimeout(id);
		}
		this.songSegmentsTimeoutArray = [];
	}

	async sendSkipMessage(segment: Segment) {
		if (
			!this.isPlaying ||
			!this.nowPlaying?.segments ||
			!this.channel?.isSendable()
		)
			return;

		const count = this.playCounter;
		const newStart = segment.segment[1];
		const skippingSong =
			Math.abs(
				Math.floor(newStart) - this.nowPlaying.details.durationInSec,
			) <= 1;
		const response = await this.channel.send({
			content: skippingSong
				? "Found non-music content, want to skip to next song?\nType \`/skip\` or react to skip"
				: `Found non-music content, want to skip to \`${timeFormat(newStart)}\`?\nType \`/relocate ${newStart}\` or react to skip`,
		});
		await response.react("✅");
		try {
			await response.awaitReactions({
				filter: (reaction) => reaction.emoji.name === "✅",
				time: 10 * 1000,
				max: 1,
			});
			await response.reactions.removeAll();
			if (this.playCounter !== count) {
				response.edit({
					content: "The song has changed, skipping cancelled",
					components: [],
				});
				return;
			}
			if (skippingSong) {
				this.stop();
				await response.edit({ content: "Skipped!" });
				return;
			}
			const data = await createResource(this.nowPlaying.url, newStart);
			if (!data) {
				response.edit(misc.errorMessageObj);
				return;
			}
			this.playResource(data, true);
			await response.edit({
				content: `Skipped to ${timeFormat(newStart)}`,
				components: [],
			});
		} catch {}
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
