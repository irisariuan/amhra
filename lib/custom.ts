import type { AudioResource } from "@discordjs/voice";
import {
	AudioPlayer,
	AudioPlayerStatus,
	type CreateAudioPlayerOptions,
} from "@discordjs/voice";
import { Channel, Client, Message, type ClientOptions } from "discord.js";
import { type YouTubeChannel, type YouTubeVideo } from "./youtube";
import { SearchCache } from "./cache";
import { globalApp } from "./misc";
import { readSetting } from "./setting";
import { createResource, Stream } from "./voice/core";
import type { VolumeControl } from "./voice/volume";
import { isSeekable } from "./voice/opusStream";
import { Segment, sendSkipMessage } from "./voice/segment";
import { segmentAt, upcomingSegments } from "./voice/segmentTiming";
import {
	armNext,
	nativePause,
	nativePlay,
	nativeResume,
	nativeSeek,
	nativeSetVolume,
	nativeSkip,
	nativeStop,
	nativeVoiceActive,
} from "./voice/native";
import {
	positionFrom,
	shouldSendPlay,
	type Promotion,
} from "./voice/nativePlan";
import { prefetch } from "./voice/stream";
import { Language } from "./interaction";

const setting = readSetting();

export interface Resource {
	channel: YouTubeChannel;
	title: string;
	details: YouTubeVideo;
	url: string;
	startFrom?: number;
	segments: Segment[] | null;
	/**
	 * The cache id, which is what the sidecar plays by.
	 *
	 * Only the native path needs it; the discord.js path already holds an open
	 * stream and never looks the track up again.
	 */
	videoId?: string;
	/**
	 * The three below belong to the discord.js path and are absent in native
	 * mode, where no audio passes through this process at all.
	 */
	resource?: AudioResource<unknown>;
	volume?: VolumeControl;
	stream?: Stream;
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
	autoSuggest: boolean;
	skipToTimestamp: number | null;
}

export class CustomClient extends Client {
	/**
	 * @description GuildID, AudioPlayer
	 */
	player: Map<string, CustomAudioPlayer>;
	cache: SearchCache;

	constructor(clientOpt: ClientOptions) {
		super(clientOpt);
		this.player = new Map();
		this.cache = new SearchCache();
	}
	clearPlayers() {
		for (const player of this.player.values()) {
			player.clearVoiceStateTimeouts();
			player.cleanStop();
		}
		this.player.clear();
	}
}

export interface QueueItem {
	url: string;
	repeating: boolean;
}

export interface AudioPlayerSetting {
	autoSkipSegment: boolean;
	looping: boolean;
	volumeNormalization: boolean;
	autoSuggest: boolean;
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

	/**
	 * Whether this player drives the Rust sidecar instead of @discordjs/voice.
	 *
	 * Decided once, when the player is created, so a flag flipped mid-song
	 * cannot leave one half of a player talking to the wrong backend.
	 */
	readonly native: boolean;
	/**
	 * The track handed to the sidecar as "what comes next", so the seam can be
	 * crossfaded. Null when nothing is armed.
	 */
	nativeArmed: string | null;
	/**
	 * The last position the sidecar reported, and when it arrived. Reports come
	 * about once a second, so the wall clock fills the gaps between them.
	 */
	nativePosition: { ms: number; at: number } | null;
	/**
	 * The track the sidecar moved to by itself when the last one ended.
	 *
	 * Recorded the moment it is known rather than read off `nativeArmed`
	 * later: the queue advance is asynchronous, and a position report arriving
	 * part-way through it re-arms whatever is at the head of the queue by then.
	 */
	nativePromoted: Promotion | null;

	constructor(
		guildId: string,
		channel: Channel | null = null,
		options?: CreateAudioPlayerOptions,
	) {
		super(options);
		this.guildId = guildId;
		this.native = nativeVoiceActive();
		this.nativeArmed = null;
		this.nativePosition = null;
		this.nativePromoted = null;

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
		this.applyGain(0);
	}

	unmute() {
		this.isMuting = false;
		this.setVolume(this.volume);
	}

	/**
	 * Send a gain to whichever backend is playing.
	 *
	 * The sidecar keeps a passthrough path at gain 1.0 where no codec runs at
	 * all, so this is the one place that decides between the two.
	 */
	private applyGain(gain: number) {
		if (this.native) return nativeSetVolume(this.guildId, gain);
		this.nowPlaying?.volume?.setVolume(gain);
	}

	resetAll() {
		this.hardStop();
		this.volume = 1;
		this.reset();
	}

	/**
	 * End playback outright, rather than moving to the next track.
	 *
	 * `stop()` means "this track is over" — the sidecar takes that as a skip
	 * and slides into whatever was armed for the seam, which is right for a
	 * skip and wrong for a stop.
	 */
	private hardStop() {
		if (!this.native) return this.stop();
		const wasPlaying = this.isPlaying;
		this.nativeArmed = null;
		this.nativePromoted = null;
		nativeStop(this.guildId);
		return wasPlaying;
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
		this.nativeArmed = null;
		this.nativePosition = null;
		this.nativePromoted = null;
	}

	cleanStop() {
		if (this.hardStop()) {
			this.reset();
			return true;
		}
		return false;
	}

	clearVoiceStateTimeouts() {
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
		this.nowPlaying = resource;
		this.isPlaying = true;
		this.isPaused = false;

		this.pauseCounter = 0;
		this.startFrom = resource.startFrom ?? 0;
		this.updateStartTime();
		if (!replay) this.history.push(resource.url);
		this.clearVoiceStateTimeouts();

		if (this.native) {
			this.startNative(resource);
		} else if (resource.resource) {
			this.play(resource.resource);
		}
		this.applyGain(
			(this.isMuting ? 0 : this.volume) * (setting.VOLUME_MODIFIER ?? 1),
		);

		this.clearSongTimeouts();
		this.updateSongTimeouts();
	}

	/**
	 * Hand a track to the sidecar, unless it is already the one playing.
	 *
	 * When a track was armed as "next", the sidecar promoted it the moment the
	 * previous one ended — that is what makes the seam gapless. The queue then
	 * advances here as it always does, and sending a `play` for the track
	 * already playing would restart it and undo the crossfade that just ran.
	 */
	private startNative(resource: Resource) {
		const trackId = resource.videoId;
		const startMs = Math.max(0, Math.round(resource.startFrom ?? 0));
		this.nativePosition = { ms: startMs, at: Date.now() };
		if (!trackId) {
			globalApp.err(`No cache id for ${resource.url}; nothing to play`);
			return;
		}
		const promoted = this.nativePromoted;
		this.nativePromoted = null;
		if (shouldSendPlay(promoted, trackId, startMs, Date.now())) {
			this.nativeArmed = null;
			nativePlay(this.guildId, trackId, startMs);
		}
		armNext(this);
	}

	setVolume(volume: number) {
		this.volume = volume;
		if (this.isPlaying && this.nowPlaying && !this.isMuting) {
			this.applyGain(volume * (setting.VOLUME_MODIFIER ?? 1));
		}
	}

	/**
	 * Move playback within the current song without rebuilding the resource.
	 *
	 * Returns false when the playing stream cannot be seeked in place (the
	 * ffmpeg fallback path), leaving the caller to recreate the resource.
	 */
	seekTo(seconds: number) {
		if (!this.nowPlaying || !this.isPlaying) return false;
		if (this.native) {
			// The sidecar plays from an indexed cache file, so every track it
			// can play at all, it can seek in.
			nativeSeek(this.guildId, seconds * 1000);
			this.nativePosition = { ms: seconds * 1000, at: Date.now() };
		} else {
			const stream = this.nowPlaying.volume;
			if (!isSeekable(stream)) return false;
			stream.relocate(seconds * 1000);
		}
		this.startFrom = seconds * 1000;
		this.pauseCounter = 0;
		this.updateStartTime();
		this.clearSongTimeouts();
		this.updateSongTimeouts();
		return true;
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
			autoSuggest: this.customSetting.autoSuggest ?? false,
			skipToTimestamp: this.currentSegment()?.segment[1] ?? null,
		};
	}
	pause() {
		if (this.isPaused) return false;
		// Read before the flag flips: once paused, the position is frozen at
		// the anchor, and everything since the last report would be lost.
		const position = this.native ? this.getCurrentSongPosition() : null;
		this.isPaused = true;
		this.pauseTimestamp = Date.now();
		if (this.native) {
			// No report arrives while paused, so the wall clock must stop
			// contributing to the position too.
			this.nativePosition = { ms: position ?? 0, at: Date.now() };
			nativePause(this.guildId);
		} else {
			super.pause();
		}
		this.updateSongTimeouts();
		return this.isPaused;
	}
	unpause() {
		const wasPaused = this.isPaused;
		if (wasPaused) {
			this.pauseCounter += Date.now() - this.pauseTimestamp;
			this.isPaused = false;
			// Time starts counting again from now, not from the last report,
			// which arrived before the pause.
			if (this.native && this.nativePosition) {
				this.nativePosition = { ...this.nativePosition, at: Date.now() };
			}
			this.updateSongTimeouts();
		}
		if (this.native) {
			nativeResume(this.guildId);
			// The callers announce success from this, so it has to mean "was
			// paused and is not any more" rather than "the message was sent".
			return wasPaused;
		}
		return super.unpause();
	}

	/**
	 * End the current track, moving on to whatever is queued.
	 *
	 * In native mode the sidecar owns playback, so this asks it to stop and the
	 * queue advances when it reports the track finished — the same order the
	 * discord.js player produces, where `stop()` leads to an idle state and the
	 * handler for that plays the next song.
	 */
	stop(force?: boolean) {
		if (!this.native) return super.stop(force);
		if (!this.isPlaying) return false;
		nativeSkip(this.guildId);
		return true;
	}

	/**
	 * Run the queue-advance handler.
	 *
	 * The base player emits this itself when a resource runs out. Nothing
	 * drives that state machine in native mode, so the sidecar's `finished`
	 * report stands in for it and both paths continue through the same code.
	 */
	signalIdle() {
		this.emit(AudioPlayerStatus.Idle, this.state, this.state);
	}
	bulkAddToQueue(
		links: string[],
		repeating = false,
		insertIndex?: number,
		maxPrefetch = 5,
	) {
		if (
			setting.USE_YOUTUBE_DL &&
			(this.queue.length > 0 || this.isPlaying)
		) {
			for (const link of maxPrefetch >= 0
				? links.slice(0, maxPrefetch)
				: links) {
				prefetch(link);
			}
		}
		const items = links.map((link) => ({
			repeating,
			url: link,
		}));
		if (
			insertIndex !== undefined &&
			insertIndex >= 0 &&
			insertIndex <= this.queue.length
		) {
			this.queue.splice(insertIndex, 0, ...items);
			return;
		}
		this.queue.push(...items);
	}

	addToQueue(
		link: string,
		repeating = false,
		insertIndex?: number,
		allowPrefetch = true,
	) {
		if (
			setting.USE_YOUTUBE_DL &&
			(this.queue.length > 0 || this.isPlaying) &&
			allowPrefetch
		) {
			prefetch(link);
		}
		if (
			insertIndex !== undefined &&
			insertIndex >= 0 &&
			insertIndex <= this.queue.length
		) {
			this.queue.splice(insertIndex, 0, { repeating, url: link });
			return;
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
		// Zero is a position, not the absence of one: a track that just
		// started sits at exactly zero, and treating that as "no position"
		// left every switched-to track with no segment timers at all.
		if (!this.nowPlaying || !this.isPlaying || currentPos === null) return;
		if (this.isPaused) {
			return this.clearSongTimeouts();
		}
		for (const { delayMs } of upcomingSegments(
			this.nowPlaying.segments,
			currentPos,
		)) {
			const id = setTimeout(() => {
				if (this.customSetting.autoSkipSegment)
					return this.skipCurrentSegment();
				sendSkipMessage(this);
			}, delayMs);
			this.songSegmentsTimeoutArray.push(id);
		}
	}

	currentSegment() {
		if (!this.nowPlaying || !this.isPlaying) return null;
		return segmentAt(
			this.nowPlaying.segments,
			this.getCurrentSongPosition(),
		);
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
		// An in-place jump keeps the same resource, so playback never restarts
		if (this.seekTo(skipTo.segment[1])) {
			return { success: true, skipped: false, skipTo };
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
		if (this.native) {
			return (
				positionFrom(this.nativePosition, this.isPaused, Date.now()) ??
				this.startFrom
			);
		}
		// The stream's anchor is the real position once it can be seeked in
		// place: the wall clock has no idea a relocate happened
		const stream = this.nowPlaying?.volume;
		if (isSeekable(stream)) return stream.positionMs;
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
