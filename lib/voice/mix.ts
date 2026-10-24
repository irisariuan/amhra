import type { Channel } from "discord.js";
import type { CustomAudioPlayer, QueueItem } from "../custom";
import { getYouTubeVideoId } from "../youtube";
import { closeQueue, createQueue, createResource, getVideoInfo, isVideo } from "./core";
import { clampGap, clampLeadIn, MAX_QUEUE_LENGTH, MAX_QUEUES } from "./queuePlan";
import { extraQueues } from "./queues";

/**
 * The mix: a guild's queues past the first, as `/mix` and the dashboard's
 * lanes have always shown them. Each is a full player (lib/custom.ts), so
 * these are only the moves the mix offers on top of what any queue can do.
 *
 * `/mix` numbers them by place in the list, 1 for queue 2; the dashboard by
 * their queue number.
 */

/** The guild's mix tracks, in order. */
export function mixTracks(guildId: string) {
	return extraQueues(guildId);
}

/** The track at a 1-based place in `/mix list`. */
export function trackAt(guildId: string, position: number): CustomAudioPlayer | undefined {
	if (!Number.isInteger(position) || position < 1) return undefined;
	return mixTracks(guildId)[position - 1];
}

/** A track by its queue number, as the dashboard names it. */
export function trackById(guildId: string, id: string): CustomAudioPlayer | undefined {
	return mixTracks(guildId).find((track) => track.sidecarQueue === id);
}

/** 1-based, as `/mix list` numbers it. Zero when it is not listed. */
export function positionOf(track: CustomAudioPlayer) {
	return mixTracks(track.guildId).indexOf(track) + 1;
}

/** Percent, as the user typed it. */
export function trackVolume(track: CustomAudioPlayer) {
	return Math.round(track.volume * 100);
}

/** A video as a queue can hold it: its title and length, nothing downloaded yet. */
export async function resolveSong(
	url: string,
	startMs?: number,
	gapBeforeMs?: number,
): Promise<QueueItem | null> {
	const videoId = isVideo(url) ? getYouTubeVideoId(url) : null;
	if (!videoId) return null;
	const info = await getVideoInfo(url).catch(() => null);
	if (!info) return null;
	const seconds = info.video_details.durationInSec;
	return {
		url: info.video_details.url,
		repeating: false,
		title: info.video_details.title,
		durationMs: seconds > 0 ? seconds * 1000 : null,
		...(startMs ? { seek: Math.floor(startMs / 1000) } : {}),
		...(gapBeforeMs === undefined ? {} : { gapBeforeMs: clampLeadIn(gapBeforeMs) }),
	};
}

export interface TrackOptions {
	/** Percent */
	volume?: number;
	gapMs?: number;
	loop?: boolean;
}

/** A new, empty track. Null when the guild already has every queue it may. */
export function addTrack(guildId: string, channel: Channel | null, options: TrackOptions = {}) {
	return createQueue(guildId, channel, {
		...options,
		volume: options.volume === undefined ? undefined : options.volume / 100,
	});
}

export type QueueOnTrackResult =
	| { track: CustomAudioPlayer; song: QueueItem; created: boolean }
	| { error: "not_found" | "full" | "queue_full" };

/**
 * Queue a video on a track, or on a new one made for it with `options`.
 *
 * Shared by `/mix add` and the dashboard, which differ only in how they find
 * the URL and how they report the outcome. The caller is responsible for the
 * bot being in voice: this only needs the sidecar to know the guild.
 */
export async function queueOnTrack(
	guildId: string,
	url: string,
	{
		track,
		index,
		startMs,
		gapBeforeMs,
		channel = null,
		...options
	}: TrackOptions & {
		track?: CustomAudioPlayer;
		index?: number;
		startMs?: number;
		/** Silence before it, in place of the track's gap */
		gapBeforeMs?: number;
		/** Where a new track sends its messages */
		channel?: Channel | null;
	} = {},
): Promise<QueueOnTrackResult> {
	// Checked before the lookup as well as after, so a full mix does not cost
	// one it will then refuse.
	if (!track && isFull(guildId)) return { error: "full" };
	const song = await resolveSong(url, startMs, gapBeforeMs);
	if (!song) return { error: "not_found" };

	let target = track;
	let created = false;
	if (target) {
		// Removed while the lookup ran
		if (target.closed) return { error: "not_found" };
	} else {
		const added = addTrack(guildId, channel, options);
		if (!added) return { error: "full" };
		target = added;
		created = true;
	}
	if (!enqueue(target, song, index)) return { error: "queue_full" };
	return { track: target, song, created };
}

/** Whether the guild has every queue it may. Queue 1 is never a mix track. */
export function isFull(guildId: string) {
	return mixTracks(guildId).length >= MAX_QUEUES - 1;
}

/**
 * Put a song on a track at `index`, or at the end. A silent track starts it
 * after its own lead-in, or straight away. False when the queue is full.
 */
export function enqueue(track: CustomAudioPlayer, song: QueueItem, index?: number) {
	if (track.queue.length >= MAX_QUEUE_LENGTH) return false;
	const at = clampIndex(index, track.queue.length);
	track.queue.splice(at, 0, song);
	track.placed(at);
	return true;
}

/** Take the song at `index` off a track's queue. */
export function removeSong(track: CustomAudioPlayer, index: number): QueueItem | null {
	if (!Number.isInteger(index) || index < 0 || index >= track.queue.length) return null;
	const [removed] = track.queue.splice(index, 1);
	if (!track.queue.length) track.wait = null;
	return removed ?? null;
}

/**
 * Move a queued song within a track or onto another. `toIndex` is where it
 * lands in the target's queue as it is after the song left. `gapBeforeMs`,
 * when given, is the silence it now waits for after whatever comes before
 * it. False when there is no song at `fromIndex`, or the target is full.
 */
export function moveSong(
	from: CustomAudioPlayer,
	fromIndex: number,
	to: CustomAudioPlayer,
	toIndex: number,
	gapBeforeMs?: number,
) {
	const song = from.queue[fromIndex];
	if (!song) return false;
	if (from !== to && to.queue.length >= MAX_QUEUE_LENGTH) return false;
	removeSong(from, fromIndex);
	const moved = gapBeforeMs === undefined ? song : { ...song, gapBeforeMs: clampLeadIn(gapBeforeMs) };
	return enqueue(to, moved, toIndex);
}

/** Move a track on to its next song now, cutting short any gap it is waiting out. */
export function skipTrack(track: CustomAudioPlayer) {
	if (track.stop()) return;
	if (track.wait) track.wait = { ...track.wait, after: "skip" };
}

/** Stop a track and drop its queue. */
export function removeTrack(track: CustomAudioPlayer) {
	closeQueue(track);
}

/** A track's volume, in percent, applied at once to whatever it is playing. */
export function setTrackVolume(track: CustomAudioPlayer, volume: number) {
	track.setVolume(Math.max(0, volume) / 100);
}

/** Change a track's gap. One being waited out stretches or shrinks to match. */
export function setTrackGap(track: CustomAudioPlayer, gapMs: number) {
	track.gapMs = clampGap(gapMs);
}

export function setTrackLoop(track: CustomAudioPlayer, loop: boolean) {
	if (loop) track.enableLoop();
	else track.disableLoop();
}

/**
 * Put another video in `song`'s place on its track, for switching to another
 * search result after `/mix add` picked the wrong one. A queued song is swapped
 * for the new one; a playing one is cut over to it. Returns what took its
 * place, or null when `song` has left the track.
 */
export async function replaceTrackSong(
	track: CustomAudioPlayer,
	song: QueueItem,
	url: string,
): Promise<QueueItem | null> {
	const next = await resolveSong(url);
	if (!next) throw new Error(`Could not find ${url}`);
	if (track.closed) return null;

	const queued = track.queue.indexOf(song);
	if (queued >= 0) {
		// Where it was put on the timeline stays where it was put
		const placed = song.gapBeforeMs === undefined ? next : { ...next, gapBeforeMs: song.gapBeforeMs };
		track.queue[queued] = placed;
		return placed;
	}
	if (track.nowPlaying?.url !== song.url) return null;
	const resource = await createResource(next.url);
	// Read after the download: the song may have ended while it ran.
	if (!resource || track.closed || track.nowPlaying?.url !== song.url) return null;
	// A play replaces what the queue holds without reporting it finished.
	track.playResource(resource);
	return next;
}

function clampIndex(index: number | undefined, length: number) {
	return index !== undefined && Number.isFinite(index)
		? Math.min(Math.max(0, Math.floor(index)), length)
		: length;
}
