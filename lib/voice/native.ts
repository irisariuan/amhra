import { existsSync } from "node:fs";
import type { VoiceBasedChannel } from "discord.js";
import type { CustomAudioPlayer, CustomClient } from "../custom";
import { dcb, globalApp } from "../misc";
import { getYouTubeVideoId } from "../youtube";
import { nativeFetchAvailable } from "./nativeFetch";
import { planArm } from "./nativePlan";
import {
	joinVoiceViaSidecar,
	sidecar,
	sidecarAvailable,
	sidecarEnabled,
	type SidecarCommand,
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
	if (!sidecarEnabled()) return false;
	if (sidecarAvailable() && nativeFetchAvailable()) return true;
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

	constructor(guildId: string, channelId: string, connected: Promise<void>) {
		this.guildId = guildId;
		this.channelId = channelId;
		this.connected = connected;
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
		if (registered) connections.delete(this.guildId);
		sidecar().send({ type: "disconnect", guildId: this.guildId });
		return registered;
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

	const connected = joinVoiceViaSidecar(channel, false).catch((error: Error) => {
		globalApp.err(`Failed to join voice via the sidecar in ${guildId}`, error);
		// Leaving a connection registered that never came up would make every
		// later command believe the bot is in the channel.
		if (connections.get(guildId) === connection) connections.delete(guildId);
		throw error;
	});
	// Nothing else awaits this, and a rejection with no handler would take the
	// process down; the commands gated on it handle their own failure.
	connected.catch(() => {});

	const connection = new NativeConnection(guildId, channel.id, connected);
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
	// With no connection the sidecar would answer every one of these with
	// "not connected to a voice channel", which is noise rather than news.
	if (!connection) return;
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
	if (!player.native || !player.isPlaying) return;
	const next = player.queue.at(0);
	const plan = planArm(next ? cachedTrackId(next.url) : null, player.nativeArmed);
	const guildId = player.guildId;

	switch (plan.action) {
		case "arm":
			player.nativeArmed = plan.trackId;
			send(guildId, { type: "setNext", guildId, trackId: plan.trackId });
			break;
		case "clear":
			player.nativeArmed = null;
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
		player.nativePosition = { ms: payload.positionMs, at: Date.now() };
		armNext(player);
	});

	bus.on("finished", (payload: { guildId: string; trackId: string }) => {
		const player = playerFor(payload.guildId);
		if (!player?.native) return;
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
		player.nativePromoted = player.nativeArmed
			? { trackId: player.nativeArmed, at: Date.now() }
			: null;
		player.nativeArmed = null;
		player.clearSongTimeouts();
		// Nothing drives the base player's state machine in this mode, so the
		// queue-advance handler is triggered from here instead. One path, the
		// same one the discord.js player takes when a track ends.
		player.signalIdle();
	});

	bus.on("starved", (payload: { guildId: string; trackId: string }) => {
		globalApp.warn(
			`Playback stalled waiting on the download of ${payload.trackId} in ${payload.guildId}`,
		);
	});

	bus.on("disconnected", (payload: { guildId: string; reason: string }) => {
		connections.delete(payload.guildId);
		const player = playerFor(payload.guildId);
		if (!player?.native) return;
		globalApp.warn(`Voice disconnected in ${payload.guildId}: ${payload.reason}`);
		player.nativeArmed = null;
		player.nativePromoted = null;
		player.nativePosition = null;
		player.clearSongTimeouts();
		player.reset();
	});
}
