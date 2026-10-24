import type { CustomAudioPlayer } from "../custom";
import { globalApp } from "../misc";
import { getYouTubeVideoId } from "../youtube";
import { updateLastUsed } from "./cache";
import { createResource, getVideoInfo, isVideo } from "./core";
import {
	clampGap,
	type GuildMix,
	type MixSong,
	type MixTrack,
	type PlayingSong,
	type TrackOptions,
} from "./mixPlan";
import {
	allMixes,
	findMix,
	getMix,
	nativeAddLayer,
	nativeNoCache,
	nativeRemoveLayer,
	nativeSetLayerVolume,
	nativeSwapLayer,
} from "./native";
import { nativeFetchReady } from "./nativeFetch";

/** How often waiting tracks are checked for a song that is due. */
const SWEEP_MS = 100;

let sweeper: ReturnType<typeof setInterval> | null = null;

/**
 * Start the songs that tracks are waiting on, as their gaps run out.
 *
 * One sweep for every guild, rather than a timer per track: a pause, a skip
 * or a removed track then only has to change what the track waits on, and
 * there is never a timer left over to fire into a mix that has gone.
 */
export function bindMixTracks() {
	if (sweeper) return;
	sweeper = setInterval(() => {
		const now = Date.now();
		for (const [guildId, mix] of allMixes()) {
			for (const track of mix.due(now)) void startNext(guildId, mix, track);
		}
	}, SWEEP_MS);
	sweeper.unref?.();
}

async function startNext(guildId: string, mix: GuildMix, track: MixTrack) {
	const song = mix.begin(track);
	if (!song) return;
	try {
		await fetchSong(song.videoId);
	} catch (error) {
		globalApp.err(`Failed to fetch ${song.videoId} for mix track ${track.id}`, error);
		if (mix.stillLoading(track, song)) mix.failed(track, Date.now());
		return;
	}
	// The fetch takes a while; the track may have been removed, skipped or
	// stopped in the meantime, and then nothing should start.
	if (findMix(guildId) !== mix || !mix.stillLoading(track, song)) return;
	const startMs = song.startMs ?? 0;
	const playing = mix.started(track, song, Date.now(), startMs);
	nativeAddLayer(guildId, playing.layerId, playing.videoId, track.volume, startMs);
	prefetch(track);
}

/**
 * Make sure enough of a video is cached for the sidecar to play it. Streaming,
 * the sidecar fetches it itself and there is no file to wait for.
 */
async function fetchSong(videoId: string) {
	if (nativeNoCache()) return;
	await nativeFetchReady(videoId);
	// Marked as used so the cache sweep does not delete a file being played.
	await updateLastUsed([videoId]).catch(() => {});
}

/** Start downloading a track's next song now, so its gap is not spent waiting on it. */
function prefetch(track: MixTrack) {
	const next = track.queue[0];
	if (next && !nativeNoCache()) fetchSong(next.videoId).catch(() => {});
}

/** A video as a track can queue it: its title and length, nothing downloaded yet. */
export async function resolveSong(
	url: string,
	startMs?: number,
	gapBeforeMs?: number,
): Promise<MixSong | null> {
	const videoId = isVideo(url) ? getYouTubeVideoId(url) : null;
	if (!videoId) return null;
	const info = await getVideoInfo(url).catch(() => null);
	if (!info) return null;
	const seconds = info.video_details.durationInSec;
	return {
		videoId,
		title: info.video_details.title,
		url: info.video_details.url,
		durationMs: seconds > 0 ? seconds * 1000 : null,
		...(startMs ? { startMs } : {}),
		...(gapBeforeMs === undefined ? {} : { gapBeforeMs: clampGap(gapBeforeMs) }),
	};
}

export type QueueOnTrackResult =
	| { track: MixTrack; song: MixSong; created: boolean }
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
		...options
	}: TrackOptions & {
		track?: MixTrack;
		index?: number;
		startMs?: number;
		/** Silence before it, in place of the track's gap */
		gapBeforeMs?: number;
	} = {},
): Promise<QueueOnTrackResult> {
	const mix = getMix(guildId);
	// Checked before the lookup as well as after, so a full mix does not cost
	// one it will then refuse.
	if (!track && mix.isFull()) return { error: "full" };
	const song = await resolveSong(url, startMs, gapBeforeMs);
	if (!song) return { error: "not_found" };

	let target = track;
	let created = false;
	if (target) {
		// Removed while the lookup ran
		if (!mix.list().includes(target)) return { error: "not_found" };
	} else {
		const added = mix.addTrack(options);
		if (!added) return { error: "full" };
		target = added;
		created = true;
	}
	if (!mix.enqueue(target, song, Date.now(), index)) return { error: "queue_full" };
	prefetch(target);
	return { track: target, song, created };
}

/** Move a track on to its next song now, without waiting out the gap. */
export function skipTrack(guildId: string, track: MixTrack) {
	const layerId = getMix(guildId).skip(track, Date.now());
	if (layerId) nativeRemoveLayer(guildId, layerId);
}

/** Stop a track and drop its queue. */
export function removeTrack(guildId: string, track: MixTrack) {
	const layerId = getMix(guildId).removeTrack(track);
	if (layerId) nativeRemoveLayer(guildId, layerId);
}

/** A track's volume, applied at once to whatever it is playing. */
export function setTrackVolume(guildId: string, track: MixTrack, volume: number) {
	track.volume = volume;
	if (track.playing) nativeSetLayerVolume(guildId, track.playing.layerId, volume);
}

/**
 * Put another video in `song`'s place on its track, for switching to another
 * search result after `/mix add` picked the wrong one. A queued song is swapped
 * for the new one; a playing one is cut over to it, at the track's volume.
 * Returns what took its place, or null when `song` has left the track.
 */
export async function replaceTrackSong(
	guildId: string,
	track: MixTrack,
	song: MixSong,
	url: string,
): Promise<MixSong | null> {
	const next = await resolveSong(url);
	if (!next) throw new Error(`Could not find ${url}`);
	const mix = getMix(guildId);
	if (!mix.list().includes(track)) return null;

	const queued = track.queue.indexOf(song);
	if (queued >= 0) {
		// Where it was put on the timeline stays where it was put
		const placed = song.gapBeforeMs === undefined ? next : { ...next, gapBeforeMs: song.gapBeforeMs };
		track.queue[queued] = placed;
		return placed;
	}
	if (track.playing?.videoId !== song.videoId) return null;
	await fetchSong(next.videoId);
	// Read after the download: the song may have ended while it ran.
	const old = track.playing;
	if (!old || old.videoId !== song.videoId) return null;
	const playing = mix.replacePlaying(track, next, Date.now());
	if (!playing) return null;
	nativeRemoveLayer(guildId, old.layerId);
	nativeAddLayer(guildId, playing.layerId, playing.videoId, track.volume);
	return playing;
}

export type SwapResult =
	/** `now` is what the track plays now: the queue's former song. */
	| { now: PlayingSong; before: PlayingSong }
	| { error: "nothing_playing" | "track_silent" | "failed" };

/**
 * Make a track's song the queue's song, and the queue's song the track's.
 *
 * Inaudible: each keeps its place and its volume. What changes is which one
 * the queue controls — skip, seek, segment skips, lyrics and now playing all
 * follow the swapped-in song, and when it ends the queue moves on as usual.
 * The swapped-out song plays on in the track until it ends, and then the
 * track moves on to its own next song.
 */
export async function swapTrackWithMain(
	player: CustomAudioPlayer,
	track: MixTrack,
): Promise<SwapResult> {
	const guildId = player.guildId;
	if (!player.nativePlayback || !player.isPlaying || !player.nowPlaying) {
		return { error: "nothing_playing" };
	}
	const layer = track.playing;
	if (!layer) return { error: "track_silent" };
	// Built first, so the queue's view can change the moment the sidecar
	// reports the swap rather than a network round trip later.
	const resource = await createResource(layer.url).catch(() => null);
	if (!resource) return { error: "failed" };

	const swapped = await nativeSwapLayer(guildId, layer.layerId);
	if (!swapped) return { error: "failed" };

	// Read after the waits: the queue may have moved on in the meantime, and
	// the sidecar's report says which track actually went into the mix.
	const outgoing = player.nowPlaying;
	const main: MixSong =
		outgoing?.videoId === swapped.layerTrackId
			? {
					videoId: swapped.layerTrackId,
					title: outgoing.title,
					url: outgoing.url,
					durationMs: outgoing.details.durationInSec * 1000 || null,
				}
			: {
					videoId: swapped.layerTrackId,
					title: swapped.layerTrackId,
					url: `https://youtu.be/${swapped.layerTrackId}`,
					durationMs: null,
				};
	const mix = getMix(guildId);
	const before = mix.swap(track, main, swapped.layerPositionMs, Date.now());
	player.adoptSwapped(resource, swapped.positionMs);
	if (!before || !track.playing) return { error: "failed" };
	return { now: track.playing, before };
}
