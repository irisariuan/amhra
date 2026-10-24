import { existsSync } from "node:fs";
import type { VoiceBasedChannel } from "discord.js";
import type { CustomAudioPlayer, CustomClient } from "../custom";
import { dcb, globalApp } from "../misc";
import { readSetting } from "../setting";
import { getYouTubeVideoId } from "../youtube";
import { gainFromPercent, GuildMix, type MixTrack } from "./mixPlan";
import { nativeFetchBin } from "./nativeFetch";
import { planArm } from "./nativePlan";
import {
	joinVoiceViaSidecar,
	LeftVoiceError,
	sidecar,
	sidecarBin,
	type SidecarCommand,
	type SidecarEvent,
} from "./sidecar";

/**
 * The playback path that runs through the Rust sidecar.
 *
 * Everything user-facing stays here: the queue, the segment timers, the
 * messages. What moves out is the part with a deadline — the voice socket, the
 * encryption and the 20ms tick — so a busy event loop can no longer stutter
 * audio. No audio crosses back; the sidecar reads the same cache files this
 * process downloads into, and reports where it is about once a second.
 *
 * With `NATIVE_NO_CACHE` on, there are no cache files either: the sidecar
 * downloads each track itself, straight into the reader that plays it, and
 * frees it once the track is done. Nothing here downloads at all then.
 *
 * This sits behind `USE_RUST_VOICE`. With the flag off, or with the binaries
 * missing, nothing here runs and @discordjs/voice keeps the job.
 */

let warnedMissing = false;

/**
 * Whether the sidecar streams tracks itself instead of playing them from the
 * cache. Only meaningful while {@link nativeVoiceActive}.
 */
export function nativeNoCache() {
	return readSetting().NATIVE_NO_CACHE === true;
}

/**
 * Whether playback should go through the sidecar right now.
 *
 * Normally both binaries are required, not just the sidecar: it plays from the
 * cache, and without the fetcher there would be nothing in it to play. With
 * caching off the sidecar fetches for itself, and it alone is enough.
 */
export function nativeVoiceActive() {
	if (!sidecarBin.enabled()) return false;
	if (sidecarBin.available() && (nativeNoCache() || nativeFetchBin.available())) {
		return true;
	}
	if (!warnedMissing) {
		warnedMissing = true;
		globalApp.warn(
			"USE_RUST_VOICE is on but the Rust binaries are missing, so playback stays on the discord.js path. Build them with: cargo build --release --manifest-path rust/Cargo.toml",
		);
	}
	return false;
}

/**
 * Stands in for a `VoiceConnection` at the call sites that only ask whether
 * there is a connection and how to end it.
 *
 * The sidecar has no object to hand back — the guild's worker thread is the
 * connection — so this exists to keep every command's "am I in voice?" check
 * working without each of them learning about two playback paths.
 */
export class NativeConnection {
	readonly guildId: string;
	readonly channelId: string;
	/**
	 * Resolves once the sidecar has been told to connect.
	 *
	 * Not once the voice handshake finishes: the sidecar registers the guild
	 * the moment it sees `connect` and its worker holds anything sent after
	 * that until audio can flow. What it will not accept is a command for a
	 * guild it has never heard of, and `connect` waits on a gateway round trip
	 * that a cached track can easily beat.
	 */
	readonly connected: Promise<void>;
	/** Give up the bot's seat in the channel, which the sidecar cannot do. */
	private readonly leaveGateway: () => void;

	constructor(
		guildId: string,
		channelId: string,
		connected: Promise<void>,
		leaveGateway: () => void,
	) {
		this.guildId = guildId;
		this.channelId = channelId;
		this.connected = connected;
		this.leaveGateway = leaveGateway;
	}

	/**
	 * discord.js routes a player's audio to a connection by subscribing it. The
	 * sidecar's worker is already the only consumer of its guild, so there is
	 * nothing to route and nothing to return.
	 */
	subscribe(_player: unknown) {
		return undefined;
	}

	disconnect() {
		const registered = connections.get(this.guildId) === this;
		if (!registered) {
			// A newer connection owns this guild. Sending `disconnect` for it
			// would tear down a session someone is listening to, on behalf of
			// one that is already gone.
			return false;
		}
		connections.delete(this.guildId);
		mixes.delete(this.guildId);
		sidecar().send({ type: "disconnect", guildId: this.guildId });
		// Closing the voice socket alone leaves the bot sitting in the channel:
		// the gateway still has it there until it is told otherwise.
		this.leaveGateway();
		return true;
	}

	/**
	 * The sidecar's session is already gone, so only the gateway half is left
	 * to undo. Sending `disconnect` as well would only draw an answer about a
	 * guild it no longer has.
	 */
	dropped() {
		if (connections.get(this.guildId) !== this) return;
		connections.delete(this.guildId);
		mixes.delete(this.guildId);
		this.leaveGateway();
	}

	/**
	 * discord.js separates disconnecting from tearing the object down, and
	 * `disconnectConnection` does both in turn. There is only one thing to do
	 * here, so this is a no-op once it has been done.
	 */
	destroy() {
		if (connections.get(this.guildId) === this) this.disconnect();
	}
}

const connections = new Map<string, NativeConnection>();

export function getNativeConnection(guildId: string) {
	return connections.get(guildId);
}

/**
 * Join a voice channel through the sidecar.
 *
 * Returns synchronously, like `joinVoice` does, because the callers reply to an
 * interaction straight after. The gateway handshake continues in the
 * background; commands sent before it lands are queued per guild by the
 * sidecar, so nothing is lost by not waiting.
 */
export function joinVoiceNative(channel: VoiceBasedChannel) {
	const guildId = channel.guild.id;
	const existing = connections.get(guildId);
	if (existing && existing.channelId === channel.id) return existing;

	const join = joinVoiceViaSidecar(channel, false, () => {
		// discord.js tells the adapter it is finished with the guild. Only the
		// connection that still owns it may act on that; a stale one would be
		// disconnecting whoever replaced it.
		if (connections.get(guildId) === connection) connection.disconnect();
	});
	const connected = join.connected.catch((error: Error) => {
		if (!(error instanceof LeftVoiceError)) {
			globalApp.err(`Failed to join voice via the sidecar in ${guildId}`, error);
		}
		// Leaving a connection registered that never came up would make every
		// later command believe the bot is in the channel.
		if (connections.get(guildId) === connection) connections.delete(guildId);
		throw error;
	});
	// Nothing else awaits this, and a rejection with no handler would take the
	// process down; the commands gated on it handle their own failure.
	connected.catch(() => {});

	const connection = new NativeConnection(guildId, channel.id, connected, join.leave);
	connections.set(guildId, connection);
	return connection;
}

/**
 * Send a command once the guild's `connect` has gone out.
 *
 * On an established connection the promise is already settled, so this costs a
 * microtask and preserves the order the commands were issued in.
 */
function send(guildId: string, command: SidecarCommand) {
	const connection = connections.get(guildId);
	if (!connection) {
		// With no connection the sidecar would answer most of these with "not
		// connected to a voice channel", which is noise rather than news.
		//
		// "Stop" is the exception, because the two sides can disagree about a
		// guild: a join that failed here after the sidecar had already
		// registered it leaves audio playing that this map knows nothing
		// about. Dropping the one command that ends it is how a guild is left
		// playing with nothing able to stop it, and the worst answer it can
		// draw is that there was nothing to stop.
		if (command.type === "stop") sidecar().send(command);
		return;
	}
	connection.connected.then(
		() => sidecar().send(command),
		() => {},
	);
}

/**
 * The sidecar's queue the guild's main queue plays on. Every queue there is a
 * full player of its own, mixed with the rest.
 */
export const MAIN_QUEUE = "1";

/** The sidecar's queue a mix track plays on. */
export function mixQueueId(track: Pick<MixTrack, "id">) {
	return `m${track.id}`;
}

/**
 * Start a track on the main queue. A new song there is one to hear, as the
 * player already assumes: it ends the guild's pause, the mix's included.
 */
export function nativePlay(guildId: string, trackId: string, startMs = 0) {
	mixes.get(guildId)?.release(Date.now());
	send(guildId, {
		type: "play",
		guildId,
		queueId: MAIN_QUEUE,
		trackId,
		startMs,
		stream: nativeNoCache(),
	});
	send(guildId, { type: "resume", guildId, queueId: null });
}

export function nativeSkip(guildId: string) {
	send(guildId, { type: "skip", guildId, queueId: MAIN_QUEUE });
}

/**
 * Silence the main queue's track. `keepLayers` leaves the mix's queues playing,
 * for a main queue that ran out rather than a listener asking for silence.
 */
export function nativeStop(guildId: string, { keepLayers = false } = {}) {
	send(guildId, { type: "stop", guildId, queueId: keepLayers ? MAIN_QUEUE : null });
}

/** Pauses every queue, so the mix's clock stops too. */
export function nativePause(guildId: string) {
	mixes.get(guildId)?.hold(Date.now());
	send(guildId, { type: "pause", guildId, queueId: null });
}

export function nativeResume(guildId: string) {
	mixes.get(guildId)?.release(Date.now());
	send(guildId, { type: "resume", guildId, queueId: null });
}

export function nativeSeek(guildId: string, positionMs: number) {
	send(guildId, {
		type: "seek",
		guildId,
		queueId: MAIN_QUEUE,
		positionMs: Math.max(0, Math.round(positionMs)),
	});
}

export function nativeSetVolume(guildId: string, gain: number) {
	send(guildId, { type: "setVolume", guildId, gain });
}

/**
 * The mix's queues live in the sidecar's guild session, so they go when it does: every
 * way a connection ends drops its mix here too.
 */
const mixes = new Map<string, GuildMix>();

/** The guild's mix, created empty on first use. */
export function getMix(guildId: string) {
	let mix = mixes.get(guildId);
	if (!mix) {
		mix = new GuildMix();
		mixes.set(guildId, mix);
	}
	return mix;
}

/** The guild's mix if it has one, without creating it. */
export function findMix(guildId: string) {
	return mixes.get(guildId);
}

/** Every guild's mix, for the sweep that starts tracks' next songs. */
export function allMixes(): IterableIterator<[string, GuildMix]> {
	return mixes.entries();
}

/** Whether the mix is playing anything, or is about to. */
export function hasLayers(guildId: string) {
	return mixes.get(guildId)?.busy() ?? false;
}

/**
 * Play a track on a mix track's own queue in the sidecar, at the track's
 * volume.
 *
 * The file only has to have started downloading: the sidecar follows a
 * growing file, and a queue that outruns its download stalls on its own while
 * the rest of the mix plays on. With caching off there is no file, and the
 * sidecar streams it the same way it streams the main queue.
 */
export function nativePlayOnTrack(
	guildId: string,
	track: Pick<MixTrack, "id" | "volume">,
	videoId: string,
	startMs = 0,
) {
	const queueId = mixQueueId(track);
	nativeSetTrackVolume(guildId, track, track.volume);
	send(guildId, {
		type: "play",
		guildId,
		queueId,
		trackId: videoId,
		startMs: Math.max(0, Math.round(startMs)),
		stream: nativeNoCache(),
	});
}

/** Fade a mix track's queue out and drop it. Nothing is reported finished. */
export function nativeRemoveTrack(guildId: string, track: Pick<MixTrack, "id">) {
	send(guildId, { type: "removeQueue", guildId, queueId: mixQueueId(track) });
}

export function nativeSetTrackVolume(
	guildId: string,
	track: Pick<MixTrack, "id">,
	volume: number,
) {
	send(guildId, {
		type: "setQueueVolume",
		guildId,
		queueId: mixQueueId(track),
		gain: gainFromPercent(volume),
	});
}

/** The queue track's own level, under the overall volume. */
export function nativeSetMainVolume(guildId: string, volume: number) {
	getMix(guildId).mainVolume = volume;
	send(guildId, {
		type: "setQueueVolume",
		guildId,
		queueId: MAIN_QUEUE,
		gain: gainFromPercent(volume),
	});
}

export function nativeSetFades(
	guildId: string,
	crossfadeMs: number,
	skipFadeMs: number,
) {
	send(guildId, { type: "setFades", guildId, queueId: null, crossfadeMs, skipFadeMs });
}

/** The cache id for a URL, but only when the whole track is already on disk. */
export function cachedTrackId(url: string) {
	const id = getYouTubeVideoId(url);
	if (!id) return null;
	return existsSync(`${process.cwd()}/cache/${id}.music`) ? id : null;
}

/**
 * The id to arm for a URL, or null when it is not ready to be armed.
 *
 * From the cache, only a track that is already fully downloaded. A partial
 * file would play and then starve at the seam, which is worse than the small
 * gap of arming nothing — and the queue's own prefetch is what fills the cache.
 * Streaming, arming is what starts the download, which lands long before the
 * seam it is for.
 */
function armableTrackId(url: string) {
	return nativeNoCache() ? getYouTubeVideoId(url) : cachedTrackId(url);
}

/**
 * Tell the sidecar what follows, so the seam between two tracks can be
 * prepared before it arrives.
 *
 * Called after each track starts and again on every position report, so a song
 * queued mid-track, or one whose download finishes mid-track, still gets armed
 * in time.
 */
export function armNext(player: CustomAudioPlayer) {
	const playback = player.nativePlayback;
	if (!playback || !player.isPlaying) return;
	const next = player.queue.at(0);
	// A track resuming from a position cannot be armed: the sidecar would
	// promote it from the top at the seam, then be told to seek a moment later.
	// Left unarmed, it starts with an ordinary `play` at the right place.
	const plan = planArm(
		next && !next.seek ? armableTrackId(next.url) : null,
		playback.armed,
	);
	const guildId = player.guildId;

	switch (plan.action) {
		case "arm":
			playback.armed = plan.trackId;
			send(guildId, {
				type: "setNext",
				guildId,
				queueId: MAIN_QUEUE,
				trackId: plan.trackId,
				stream: nativeNoCache(),
			});
			break;
		case "clear":
			playback.armed = null;
			send(guildId, { type: "clearNext", guildId, queueId: MAIN_QUEUE });
			break;
		case "none":
			break;
	}
}

let boundClient: CustomClient | null = null;

/**
 * Route the sidecar's reports into the players.
 *
 * Idempotent, and safe to call before anything is playing: the point is that
 * the very first `finished` has somewhere to land.
 */
export function bindNativeVoice(client: CustomClient) {
	if (boundClient === client) return;
	boundClient = client;
	const bus = sidecar();

	const playerFor = (guildId: string) => client.player.get(guildId) ?? null;

	bus.on("ready", (payload: { guildId: string; daveVersion: number }) => {
		dcb.log(
			`Voice ready in ${payload.guildId}${payload.daveVersion ? ` (DAVE v${payload.daveVersion})` : ""}`,
		);
	});

	/**
	 * The mix track playing `trackId` on `queueId`. A report naming another
	 * song is a late one from before a skip or a replacement, and is ignored.
	 */
	const mixTrackFor = (guildId: string, queueId: string, trackId: string) => {
		const mix = mixes.get(guildId);
		const track = mix?.list().find((track) => mixQueueId(track) === queueId);
		const playing = track?.playing;
		if (!mix || !playing || playing.videoId !== trackId) return null;
		return { mix, layerId: playing.layerId };
	};

	bus.on("started", (payload: { guildId: string; queueId: string; trackId: string }) => {
		dcb.log(`Sidecar started ${payload.trackId} on queue ${payload.queueId} in ${payload.guildId}`);
		if (payload.queueId === MAIN_QUEUE) return;
		// Streaming, the audio begins a fetch after it was asked for.
		const found = mixTrackFor(payload.guildId, payload.queueId, payload.trackId);
		found?.mix.layerStarted(found.layerId, Date.now());
	});

	bus.on("position", (payload: { guildId: string; queueId: string; positionMs: number }) => {
		if (payload.queueId !== MAIN_QUEUE) return;
		const player = playerFor(payload.guildId);
		if (!player) return;
		player.nativePlayback?.anchorAt(payload.positionMs, Date.now());
		armNext(player);
	});

	bus.on("finished", (payload: { guildId: string; queueId: string; trackId: string }) => {
		if (payload.queueId !== MAIN_QUEUE) {
			// Ended on its own or cleared by a stop: the track waits out its
			// gap and moves on.
			const found = mixTrackFor(payload.guildId, payload.queueId, payload.trackId);
			found?.mix.finish(found.layerId, Date.now());
			return;
		}
		const player = playerFor(payload.guildId);
		const playback = player?.nativePlayback;
		if (!player || !playback) return;
		// A report for a track that is no longer the current one is stale — a
		// direct `play` replaces the active slot without finishing it — and
		// advancing on it would skip whatever just started.
		if (player.nowPlaying?.videoId && player.nowPlaying.videoId !== payload.trackId) {
			return;
		}
		// An armed track is playing already: the sidecar promoted it on the
		// same tick the last one ended, which is what makes the seam seamless.
		// Captured here, before the advance below runs, because that advance
		// is asynchronous and a position report landing part-way through it
		// re-arms the new queue head over the top of this.
		playback.promote(Date.now());
		player.clearSongTimeouts();
		// Nothing drives the base player's state machine in this mode, so the
		// queue-advance handler is triggered from here instead. One path, the
		// same one the discord.js player takes when a track ends.
		player.signalIdle();
	});

	bus.on("starved", (payload: { guildId: string; queueId: string; trackId: string }) => {
		globalApp.warn(
			`Queue ${payload.queueId} stalled waiting on the download of ${payload.trackId} in ${payload.guildId}`,
		);
	});

	bus.on("disconnected", (payload: { guildId: string; reason: string }) => {
		// The answer to our own `disconnect`, which already cleaned up here. By
		// the time it lands the guild may have been joined again, and acting on
		// it would tear the new connection down.
		if (payload.reason === "asked to leave") return;
		// The voice session dropped for good. Without this the bot would stay
		// seated in the channel, silent, with nothing left that could make it
		// leave.
		connections.get(payload.guildId)?.dropped();
		const player = playerFor(payload.guildId);
		if (!player?.nativePlayback) return;
		globalApp.warn(`Voice disconnected in ${payload.guildId}: ${payload.reason}`);
		player.nativePlayback.clear();
		player.clearSongTimeouts();
		player.reset();
	});
}
