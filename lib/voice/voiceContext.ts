import type { CustomAudioPlayer, CustomClient } from "../custom";
import type { GuildMix } from "./mixPlan";

/**
 * What the voice command model is told about the bot as it stands: what is
 * playing, what is queued, the volume and the playback settings. With it the
 * model can answer "what's next?" or "how loud is it?" aloud, and read "skip
 * the Taylor Swift one" against the queue.
 *
 * A queued song's title and channel are only known once the video has been
 * looked up. Those already looked up are given; the rest are looked up only
 * for as long as {@link RESOLVE_WITHIN_MS}, since the person is waiting, and
 * after that are given by their link.
 */

/** Queued songs described, from the front. The model needs no more. */
export const QUEUE_SHOWN = 10;
/** How long looking up queued songs' titles may hold up the answer. */
export const RESOLVE_WITHIN_MS = 400;

export interface Song {
	url: string;
	title?: string;
	channel?: string;
	/** Seconds; 0 for a livestream or when not known. */
	duration?: number;
	repeating?: boolean;
}

export interface PlaybackState {
	nowPlaying: (Song & { positionMs: number | null }) | null;
	paused: boolean;
	/** The whole queue's length, of which `queue` is the front. */
	queueLength: number;
	queue: Song[];
	/** Percent, 100 being normal. */
	volume: number;
	muted: boolean;
	loop: boolean;
	autoSuggest: boolean;
	autoSkipNonMusic: boolean;
	crossfadeMs: number;
	/** Songs mixed in over the queue's, in their numbered order. */
	mix: { title: string; volume: number }[];
	/** Percent, the queue's song in the mix. */
	mixMainVolume: number;
}

/** A time as M:SS, or H:MM:SS. */
function clock(seconds: number) {
	const whole = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(whole / 3600);
	const minutes = Math.floor((whole % 3600) / 60);
	const rest = String(whole % 60).padStart(2, "0");
	return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function song({ url, title, channel, duration }: Song) {
	if (!title) return `${url} (title not looked up)`;
	const by = channel ? ` by ${channel}` : "";
	const length = duration ? `, ${clock(duration)}` : "";
	return `"${title}"${by}${length}`;
}

const onOff = (on: boolean) => (on ? "on" : "off");

/** The state as the model reads it: a few plain lines. */
export function describePlayback(state: PlaybackState | null): string {
	if (!state) return "Nothing is playing and the queue is empty.";
	const lines: string[] = [];
	const playing = state.nowPlaying;
	if (playing) {
		const at =
			playing.positionMs !== null && playing.duration
				? `, at ${clock(playing.positionMs / 1000)} of ${clock(playing.duration)}`
				: "";
		lines.push(`Now playing: ${song(playing)}${at}${state.paused ? " (paused)" : ""}`);
	} else {
		lines.push("Now playing: nothing");
	}
	if (state.queueLength === 0) {
		lines.push("Queue: empty");
	} else {
		lines.push(`Queue (${state.queueLength} song${state.queueLength === 1 ? "" : "s"}, next first):`);
		state.queue.forEach((item, index) => {
			lines.push(`${index + 1}. ${song(item)}${item.repeating ? " (repeats)" : ""}`);
		});
		if (state.queueLength > state.queue.length) {
			lines.push(`…and ${state.queueLength - state.queue.length} more`);
		}
	}
	lines.push(`Volume: ${Math.round(state.volume)}%${state.muted ? " (muted)" : ""}`);
	lines.push(
		`Loop: ${onOff(state.loop)}. Suggesting songs when the queue runs out: ${onOff(state.autoSuggest)}. Skipping non-music parts automatically: ${onOff(state.autoSkipNonMusic)}. Crossfade: ${state.crossfadeMs ? `${state.crossfadeMs / 1000}s` : "off"}.`,
	);
	if (state.mix.length) {
		lines.push(`Mixed in over the queue's song (at ${Math.round(state.mixMainVolume)}%):`);
		state.mix.forEach((layer, index) => {
			lines.push(`${index + 1}. "${layer.title}" at ${Math.round(layer.volume)}%`);
		});
	}
	return lines.join("\n");
}

type Lookup = (url: string) => Promise<Omit<Song, "url"> | null>;

/**
 * `url`'s title and channel if they are already known, else looked up until
 * `deadline`: past that, nothing, and the lookup carries on to fill the cache
 * for the next time.
 */
async function resolve(client: CustomClient, url: string, deadline: Promise<null>, lookup: Lookup): Promise<Song> {
	const cached = client.cache.getUrl(url);
	if (cached?.isVideo()) {
		return { url, title: cached.value.title, channel: cached.value.channel?.name, duration: cached.value.durationInSec };
	}
	const found = await Promise.race([lookup(url).catch(() => null), deadline]);
	return { url, ...found };
}

// Loaded when first needed, so what only describes the state does not load
// the downloader.
const lookUp: Lookup = async (url) => {
	const { getVideoInfo } = await import("./core.js");
	const details = (await getVideoInfo(url))?.video_details;
	if (!details) return null;
	return { title: details.title, channel: details.channel?.name, duration: details.durationInSec };
};

/** The guild's player as the model is told it, or null with nothing to tell. */
export async function playbackState(
	client: CustomClient,
	guildId: string,
	{
		within = RESOLVE_WITHIN_MS,
		lookup = lookUp,
		mixOf = async (guildId: string) => (await import("./native.js")).findMix(guildId),
	}: { within?: number; lookup?: Lookup; mixOf?: (guildId: string) => Promise<GuildMix | undefined> } = {},
): Promise<PlaybackState | null> {
	const player: CustomAudioPlayer | undefined = client.player.get(guildId);
	if (!player) return null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<null>((done) => {
		timer = setTimeout(() => done(null), within);
	});
	try {
		const queue = await Promise.all(
			player.queue.slice(0, QUEUE_SHOWN).map(async (item) => ({
				...(await resolve(client, item.url, deadline, lookup)),
				repeating: item.repeating,
			})),
		);
		const current = player.isPlaying ? player.nowPlaying : null;
		const mix = await mixOf(guildId);
		return {
			nowPlaying: current
				? {
						url: current.url,
						title: current.details.title ?? current.title,
						channel: current.channel?.name,
						duration: current.details.durationInSec,
						positionMs: player.getCurrentSongPosition(),
					}
				: null,
			paused: player.isPaused,
			queueLength: player.queue.length,
			queue,
			volume: player.volume * 100,
			muted: player.isMuting,
			loop: player.customSetting.looping ?? false,
			autoSuggest: player.customSetting.autoSuggest ?? false,
			autoSkipNonMusic: player.customSetting.autoSkipSegment ?? false,
			crossfadeMs: player.native ? player.crossfadeMs : 0,
			mix: (mix?.list() ?? []).map((layer) => ({ title: layer.title, volume: layer.volume })),
			mixMainVolume: mix?.mainVolume ?? 100,
		};
	} finally {
		clearTimeout(timer);
	}
}
