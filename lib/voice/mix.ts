import { globalApp } from "../misc";
import { getYouTubeVideoId } from "../youtube";
import { updateLastUsed } from "./cache";
import { getVideoInfo, isVideo } from "./core";
import type { MixLayer } from "./mixPlan";
import { getMix, nativeAddLayer } from "./native";
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
): Promise<AddLayerResult> {
	const trackId = isVideo(url) ? getYouTubeVideoId(url) : null;
	if (!trackId) return { error: "not_found" };
	// Checked before the download as well as after, so a full mix does not
	// cost a fetch it will then refuse.
	if (getMix(guildId).isFull()) return { error: "full" };

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

	const layer = nativeAddLayer(guildId, {
		trackId,
		title: info.video_details.title,
		url: info.video_details.url,
		volume,
	});
	return layer ? { layer } : { error: "full" };
}
