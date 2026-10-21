import { existsSync } from "node:fs";
import type { VoiceBasedChannel } from "discord.js";
import type { CustomAudioPlayer, CustomClient } from "../custom";
import { dcb, globalApp } from "../misc";
import { getYouTubeVideoId } from "../youtube";
import { gainFromPercent, GuildMix, type MixLayer } from "./mixPlan";
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
 * This sits behind `USE_RUST_VOICE`. With the flag off, or with the binaries
 * missing, nothing here runs and @discordjs/voice keeps the job.
 */

let warnedMissing = false;

/**
 * Whether playback should go through the sidecar right now.
 *
 * Both binaries are required, not just the sidecar: the sidecar plays from the
 * cache and never downloads, so without the fetcher there would be nothing for
 * it to play.
 */
export function nativeVoiceActive() {
	if (!sidecarBin.enabled()) return false;
	if (sidecarBin.available() && nativeFetchBin.available()) return true;
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

export function nativePlay(guildId: string, trackId: string, startMs = 0) {
	send(guildId, { type: "play", guildId, trackId, startMs });
}

export function nativeSkip(guildId: string) {
	send(guildId, { type: "skip", guildId });
}

export function nativeStop(guildId: string) {
	send(guildId, { type: "stop", guildId });
}

export function nativePause(guildId: string) {
	send(guildId, { type: "pause", guildId });
}

export function nativeResume(guildId: string) {
	send(guildId, { type: "resume", guildId });
}

export function nativeSeek(guildId: string, positionMs: number) {
	send(guildId, {
		type: "seek",
		guildId,
		positionMs: Math.max(0, Math.round(positionMs)),
	});
}

export function nativeSetVolume(guildId: string, gain: number) {
	send(guildId, { type: "setVolume", guildId, gain });
}

/**
 * Layers live in the sidecar's guild session, so they go when it does: every
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

/** Whether anything is mixed in over the queue right now. */
export function hasLayers(guildId: string) {
	return (mixes.get(guildId)?.size ?? 0) > 0;
}

/**
 * Play a cached track alongside the queue. Null when the mix is already full.
 *
 * The file only has to have started downloading: the sidecar follows a
 * growing file, and a layer that outruns its download stalls on its own while
 * the rest of the mix plays on.
 */
export function nativeAddLayer(
	guildId: string,
	track: Omit<MixLayer, "id">,
	startMs = 0,
): MixLayer | null {
	const layer = getMix(guildId).add(track);
	if (!layer) return null;
	send(guildId, {
		type: "addLayer",
		guildId,
		layerId: layer.id,
		trackId: layer.trackId,
		gain: gainFromPercent(layer.volume),
		startMs: Math.max(0, Math.round(startMs)),
	});
	return layer;
}

export function nativeRemoveLayer(guildId: string, layer: MixLayer) {
	// Forgotten now rather than on `layerFinished`, so the list a user reads
	// next already reflects what they asked for.
	getMix(guildId).forget(layer.id);
	send(guildId, { type: "removeLayer", guildId, layerId: layer.id });
}

/** How long to wait for the sidecar to confirm a swap before giving up on it. */
const SWAP_TIMEOUT_MS = 3_000;

export type LayerSwap = Extract<SidecarEvent, { type: "layerSwapped" }>;

/**
 * Ask the sidecar to trade a layer with the queue's track, and wait for it to
 * say it has. Null when it refused — nothing playing on the queue, or a fade
 * in progress — which it reports as an error for the guild.
 *
 * Waited on rather than assumed, because the bot's view of what is playing
 * must only move once the audio has: a refused swap followed by an optimistic
 * one here would leave every later report about the wrong track.
 */
export function nativeSwapLayer(guildId: string, layerId: string) {
	if (!connections.has(guildId)) return Promise.resolve(null);
	const bus = sidecar();
	return new Promise<LayerSwap | null>((resolve) => {
		const finish = (result: LayerSwap | null) => {
			clearTimeout(timer);
			bus.off("layerSwapped", onSwapped);
			bus.off("error", onError);
			resolve(result);
		};
		const onSwapped = (payload: LayerSwap) => {
			if (payload.guildId === guildId && payload.layerId === layerId) finish(payload);
		};
		const onError = (payload: { guildId: string | null }) => {
			if (payload.guildId === guildId) finish(null);
		};
		const timer = setTimeout(() => finish(null), SWAP_TIMEOUT_MS);
		bus.on("layerSwapped", onSwapped);
		bus.on("error", onError);
		send(guildId, { type: "swapLayer", guildId, layerId });
	});
}

export function nativeSetLayerVolume(guildId: string, layer: MixLayer, volume: number) {
	getMix(guildId).setVolume(layer.id, volume);
	send(guildId, {
		type: "setLayerVolume",
		guildId,
		layerId: layer.id,
		gain: gainFromPercent(volume),
	});
}

/** The queue track's own level, under the overall volume. */
export function nativeSetMainVolume(guildId: string, volume: number) {
	getMix(guildId).mainVolume = volume;
	send(guildId, { type: "setMainVolume", guildId, gain: gainFromPercent(volume) });
}

export function nativeSetFades(
	guildId: string,
	crossfadeMs: number,
	skipFadeMs: number,
) {
	send(guildId, { type: "setFades", guildId, crossfadeMs, skipFadeMs });
}

/** The cache id for a URL, but only when the whole track is already on disk. */
export function cachedTrackId(url: string) {
	const id = getYouTubeVideoId(url);
	if (!id) return null;
	return existsSync(`${process.cwd()}/cache/${id}.music`) ? id : null;
}

/**
 * Tell the sidecar what follows, so the seam between two tracks can be
 * prepared before it arrives.
 *
 * Only a track that is already fully downloaded is armed. A partial file would
 * play and then starve at the seam, which is worse than the small gap of
 * arming nothing — and the queue's own prefetch is what fills the cache.
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
		next && !next.seek ? cachedTrackId(next.url) : null,
		playback.armed,
	);
	const guildId = player.guildId;

	switch (plan.action) {
		case "arm":
			playback.armed = plan.trackId;
			send(guildId, { type: "setNext", guildId, trackId: plan.trackId });
			break;
		case "clear":
			playback.armed = null;
			send(guildId, { type: "clearNext", guildId });
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

	bus.on("started", (payload: { guildId: string; trackId: string }) => {
		dcb.log(`Sidecar started ${payload.trackId} in ${payload.guildId}`);
	});

	bus.on("position", (payload: { guildId: string; positionMs: number }) => {
		const player = playerFor(payload.guildId);
		if (!player) return;
		player.nativePlayback?.anchorAt(payload.positionMs, Date.now());
		armNext(player);
	});

	bus.on("finished", (payload: { guildId: string; trackId: string }) => {
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

	bus.on("layerStarted", (payload: { guildId: string; layerId: string }) => {
		dcb.log(`Sidecar started layer ${payload.layerId} in ${payload.guildId}`);
	});

	// Ended on its own, removed, or cleared by a stop: in every case it is no
	// longer playing, so it leaves the list.
	bus.on("layerFinished", (payload: { guildId: string; layerId: string }) => {
		mixes.get(payload.guildId)?.forget(payload.layerId);
	});

	bus.on("layerStarved", (payload: { guildId: string; layerId: string }) => {
		globalApp.warn(
			`Layer ${payload.layerId} stalled waiting on its download in ${payload.guildId}`,
		);
	});

	bus.on("starved", (payload: { guildId: string; trackId: string }) => {
		globalApp.warn(
			`Playback stalled waiting on the download of ${payload.trackId} in ${payload.guildId}`,
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
