import type { CustomAudioPlayer } from "../custom";
import { globalApp } from "../misc";
import { getYouTubeVideoId } from "../youtube";
import { updateLastUsed } from "./cache";
import { createResource, getVideoInfo, isVideo } from "./core";
import type { MixLayer } from "./mixPlan";
import {
	getMix,
	nativeAddLayer,
	nativeReplaceLayer,
	nativeSwapLayer,
} from "./native";
import { nativeFetchReady } from "./nativeFetch";

export type AddLayerResult =
	| { layer: MixLayer }
	| { error: "not_found" | "full" | "failed" };

/**
 * Download a video and mix it in over the guild's queue.
 *
 * Shared by `/mix add` and the dashboard, which differ only in how they find
 * the URL and how they report the outcome. The caller is responsible for the
 * bot being in voice: this only needs the sidecar to know the guild.
 */
export async function addLayerFromInput(
	guildId: string,
	url: string,
	volume: number,
	startMs = 0,
): Promise<AddLayerResult> {
	// Checked before the download as well as after, so a full mix does not
	// cost a fetch it will then refuse.
	if (getMix(guildId).isFull()) return { error: "full" };
	const track = await fetchLayerTrack(url);
	if ("error" in track) return track;

	const layer = nativeAddLayer(guildId, { ...track, volume }, startMs);
	return layer ? { layer } : { error: "full" };
}

/**
 * Download a video and play it in place of `layer`, keeping its volume and
 * its number in the list. For switching to another search result after
 * `/mix add` picked the wrong one.
 */
export async function replaceLayerFromInput(
	guildId: string,
	layer: MixLayer,
	url: string,
): Promise<AddLayerResult | { error: "gone" }> {
	const track = await fetchLayerTrack(url);
	if ("error" in track) return track;
	// Read after the download: the layer may have been removed or have ended
	// while it ran.
	const replaced = nativeReplaceLayer(guildId, layer, track);
	return replaced ? { layer: replaced } : { error: "gone" };
}

/** A video's details, once enough of it is cached for the sidecar to play. */
async function fetchLayerTrack(
	url: string,
): Promise<Omit<MixLayer, "id" | "volume"> | { error: "not_found" | "failed" }> {
	const trackId = isVideo(url) ? getYouTubeVideoId(url) : null;
	if (!trackId) return { error: "not_found" };
	const info = await getVideoInfo(url).catch(() => null);
	if (!info) return { error: "not_found" };
	try {
		await nativeFetchReady(trackId);
	} catch (error) {
		globalApp.err(`Failed to fetch ${trackId} for a mix layer`, error);
		return { error: "failed" };
	}
	// Marked as used so the cache sweep does not delete a file being played.
	await updateLastUsed([trackId]).catch(() => {});
	return { trackId, title: info.video_details.title, url: info.video_details.url };
}

export type SwapResult =
	/** `layer` is what the layer holds now: the queue's former song. */
	| { layer: MixLayer; playing: MixLayer }
	| { error: "nothing_playing" | "failed" };

/**
 * Make a mixed-in song the queue's song, and the queue's song a mixed-in one.
 *
 * Inaudible: each keeps its place and its volume. What changes is which one
 * the queue controls — skip, seek, segment skips, lyrics and now playing all
 * follow the swapped-in song, and when it ends the queue moves on as usual.
 * The swapped-out song plays on in the mix until it ends.
 */
export async function swapLayerWithMain(
	player: CustomAudioPlayer,
	layer: MixLayer,
): Promise<SwapResult> {
	const guildId = player.guildId;
	if (!player.nativePlayback || !player.isPlaying || !player.nowPlaying) {
		return { error: "nothing_playing" };
	}
	// Built first, so the queue's view can change the moment the sidecar
	// reports the swap rather than a network round trip later.
	const resource = await createResource(layer.url).catch(() => null);
	if (!resource) return { error: "failed" };

	const swapped = await nativeSwapLayer(guildId, layer.id);
	if (!swapped) return { error: "failed" };

	// Read after the waits: the queue may have moved on in the meantime, and
	// the sidecar's report says which track actually went into the mix.
	const outgoing = player.nowPlaying;
	const main =
		outgoing?.videoId === swapped.layerTrackId
			? { trackId: swapped.layerTrackId, title: outgoing.title, url: outgoing.url }
			: {
					trackId: swapped.layerTrackId,
					title: swapped.layerTrackId,
					url: `https://youtu.be/${swapped.layerTrackId}`,
				};
	const before = getMix(guildId).swap(layer.id, main);
	player.adoptSwapped(resource, swapped.positionMs);
	const now = getMix(guildId).list().find((l) => l.id === layer.id);
	if (!before || !now) return { error: "failed" };
	return { layer: now, playing: before };
}
