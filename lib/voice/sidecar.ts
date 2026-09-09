import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { Guild, VoiceBasedChannel } from "discord.js";
import { z } from "zod";
import { dcb, globalApp } from "../misc";
import { readSetting } from "../setting";
import { fadesFrom } from "./fades";

/**
 * Client for the Rust voice sidecar.
 *
 * The bot keeps the main gateway, the queue, and every user-facing decision.
 * The sidecar owns the voice connection, the encryption and the 20ms tick —
 * the parts that must not wait on this event loop. Audio never crosses the
 * boundary: what travels is a handful of control messages per user action, so
 * a track playing costs this process nothing.
 *
 * Frames are length-prefixed JSON (4-byte big-endian length, then the body)
 * over the child's stdin and stdout. Logs come back on stderr and are never
 * framed, which is what keeps stdout parseable.
 */

/** Kept in step with PROTOCOL_VERSION in the Rust protocol module. */
const PROTOCOL_VERSION = 1;
/** Restart backoff bounds after an unexpected exit. */
const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
/**
 * How long to let a leave settle before rejoining. The gateway has to see the
 * old voice state go before it will treat the next op 4 as a new session.
 */
const VOICE_STATE_RESET_MS = 500;

const sessionState = z.object({
	guildId: z.string(),
	channelId: z.string(),
	trackId: z.string().nullable(),
	positionMs: z.number(),
	paused: z.boolean(),
	gain: z.number(),
});

/**
 * Mirrors the Event enum in rust/amhra-sidecar/src/protocol.rs, whose generated
 * declarations live in that crate's bindings/protocol.d.ts. Parsed rather than
 * cast: this is a process boundary, and a version skew should be a clear error
 * rather than an undefined field three calls later.
 */
const event = z.discriminatedUnion("type", [
	z.object({ type: z.literal("hello"), version: z.number(), pid: z.number() }),
	z.object({ type: z.literal("ready"), guildId: z.string(), daveVersion: z.number() }),
	z.object({ type: z.literal("started"), guildId: z.string(), trackId: z.string() }),
	z.object({ type: z.literal("finished"), guildId: z.string(), trackId: z.string() }),
	z.object({ type: z.literal("starved"), guildId: z.string(), trackId: z.string() }),
	z.object({
		type: z.literal("position"),
		guildId: z.string(),
		trackId: z.string(),
		positionMs: z.number(),
	}),
	z.object({ type: z.literal("idle"), guildId: z.string() }),
	z.object({ type: z.literal("reconnecting"), guildId: z.string(), reason: z.string() }),
	z.object({ type: z.literal("disconnected"), guildId: z.string(), reason: z.string() }),
	z.object({
		type: z.literal("error"),
		guildId: z.string().nullable(),
		message: z.string(),
	}),
	z.object({ type: z.literal("sessions"), guilds: z.array(sessionState) }),
]);

export type SidecarEvent = z.infer<typeof event>;
export type SidecarSession = z.infer<typeof sessionState>;

export type SidecarCommand =
	| {
			type: "connect";
			guildId: string;
			channelId: string;
			userId: string;
			sessionId: string;
			endpoint: string;
			token: string;
	  }
	| { type: "disconnect"; guildId: string }
	| { type: "play"; guildId: string; trackId: string; startMs?: number }
	| { type: "setNext"; guildId: string; trackId: string }
	| { type: "clearNext"; guildId: string }
	| { type: "skip"; guildId: string }
	| { type: "stop"; guildId: string }
	| { type: "pause"; guildId: string }
	| { type: "resume"; guildId: string }
	| { type: "seek"; guildId: string; positionMs: number }
	| { type: "setVolume"; guildId: string; gain: number }
	| { type: "setFades"; guildId: string; crossfadeMs: number; skipFadeMs: number }
	| { type: "listSessions" }
	| { type: "shutdown" };

export function sidecarBinary() {
	return (
		readSetting().NATIVE_VOICE_BIN ??
		`${process.cwd()}/rust/target/release/amhra-sidecar`
	);
}

export function sidecarEnabled() {
	return readSetting().USE_RUST_VOICE === true;
}

export function sidecarAvailable() {
	return existsSync(sidecarBinary());
}

/**
 * A running sidecar process, restarted if it dies.
 *
 * Emits every {@link SidecarEvent} by its `type`, and `"event"` for anything
 * that wants the whole stream.
 */
export class Sidecar extends EventEmitter {
	private child: ChildProcessWithoutNullStreams | null = null;
	private pending = Buffer.alloc(0);
	private backoff = MIN_BACKOFF_MS;
	private stopping = false;
	/** Guilds the sidecar is connected to, so a restart can be reported. */
	readonly guilds = new Set<string>();

	start() {
		if (this.child) return;
		this.stopping = false;

		const binary = sidecarBinary();
		dcb.log(`Starting voice sidecar: ${binary}`);
		const child = spawn(binary, ["--cache-dir", `${process.cwd()}/cache`], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;

		child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString().split("\n")) {
				if (line.trim()) dcb.log(`sidecar: ${line.trim()}`);
			}
		});
		child.on("error", (error) => {
			globalApp.err(`Voice sidecar failed to run: ${binary}`, error);
		});
		child.on("close", (code) => {
			this.child = null;
			this.pending = Buffer.alloc(0);
			// Every guild it was holding is gone with it.
			for (const guildId of this.guilds) {
				this.emit("disconnected", {
					type: "disconnected",
					guildId,
					reason: `sidecar exited (${code})`,
				});
			}
			this.guilds.clear();
			if (this.stopping) return;

			globalApp.warn(`Voice sidecar exited (${code}), restarting in ${this.backoff}ms`);
			setTimeout(() => this.start(), this.backoff);
			this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
		});
	}

	/** Stop without restarting. */
	stop() {
		this.stopping = true;
		if (!this.child) return;
		this.send({ type: "shutdown" });
		// The sidecar also exits when its stdin closes, so this is belt and
		// braces rather than the only route out.
		this.child.stdin.end();
		this.child = null;
		this.guilds.clear();
	}

	get running() {
		return this.child !== null;
	}

	send(command: SidecarCommand) {
		const child = this.child;
		if (!child) {
			globalApp.warn(`Voice sidecar is not running; dropped ${command.type}`);
			return false;
		}
		const payload = Buffer.from(JSON.stringify(command), "utf8");
		const header = Buffer.alloc(4);
		header.writeUInt32BE(payload.length, 0);
		// One write, so a crash cannot leave a header without its body.
		return child.stdin.write(Buffer.concat([header, payload]));
	}

	/** Wait for the next event of a given type for a guild. */
	waitFor<T extends SidecarEvent["type"]>(
		type: T,
		guildId: string,
		timeoutMs = 15_000,
	): Promise<Extract<SidecarEvent, { type: T }>> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.off(type, onEvent);
				reject(new Error(`timed out waiting for ${type} in ${guildId}`));
			}, timeoutMs);

			const onEvent = (payload: SidecarEvent) => {
				if ("guildId" in payload && payload.guildId !== guildId) return;
				clearTimeout(timer);
				this.off(type, onEvent);
				resolve(payload as Extract<SidecarEvent, { type: T }>);
			};
			this.on(type, onEvent);
		});
	}

	/** Split the byte stream back into frames. */
	private consume(chunk: Buffer) {
		this.pending = Buffer.concat([this.pending, chunk]);

		for (;;) {
			if (this.pending.length < 4) return;
			const length = this.pending.readUInt32BE(0);
			if (this.pending.length < 4 + length) return;

			const body = this.pending.subarray(4, 4 + length);
			this.pending = this.pending.subarray(4 + length);

			let parsed: SidecarEvent;
			try {
				parsed = event.parse(JSON.parse(body.toString("utf8")));
			} catch (error) {
				// An unparseable event means the two sides disagree about the
				// protocol, which is worth saying loudly and exactly once per
				// frame rather than crashing the bot.
				globalApp.err(
					`Unrecognised sidecar event: ${body.toString("utf8").slice(0, 200)}`,
					error as Error,
				);
				continue;
			}

			this.track(parsed);
			this.emit(parsed.type, parsed);
			this.emit("event", parsed);
		}
	}

	private track(payload: SidecarEvent) {
		switch (payload.type) {
			case "hello":
				// A version mismatch is not fatal on its own, but it explains
				// every strange thing that follows.
				if (payload.version !== PROTOCOL_VERSION) {
					globalApp.warn(
						`Voice sidecar speaks protocol ${payload.version}, this bot speaks ${PROTOCOL_VERSION}`,
					);
				}
				this.backoff = MIN_BACKOFF_MS;
				dcb.log(`Voice sidecar ready (pid ${payload.pid})`);
				break;
			case "ready":
				this.guilds.add(payload.guildId);
				break;
			case "disconnected":
				this.guilds.delete(payload.guildId);
				break;
			case "error":
				globalApp.err(
					`Voice sidecar error${payload.guildId ? ` in ${payload.guildId}` : ""}: ${payload.message}`,
				);
				break;
			default:
				break;
		}
	}
}

/**
 * The fade lengths a fresh guild starts with, from the global config.
 *
 * A guild can then be adjusted away from this from the dashboard's player
 * controls; this is only the default it begins at.
 */
export function fadeSettings() {
	return fadesFrom(readSetting());
}

let shared: Sidecar | null = null;

/** The process-wide sidecar, started on first use. */
export function sidecar() {
	if (!shared) {
		shared = new Sidecar();
		shared.start();
	}
	return shared;
}

export function stopSidecar() {
	shared?.stop();
	shared = null;
}

/**
 * Join a voice channel and hand the connection to the sidecar.
 *
 * discord.js already knows how to do the gateway half of this: its
 * `voiceAdapterCreator` sends the op 4 voice state update and reports the two
 * events that answer it. Reusing it means the sidecar never needs a gateway
 * connection of its own, and the bot's existing shard handles everything.
 */
export function joinVoiceViaSidecar(
	channel: VoiceBasedChannel,
	deaf = true,
	onLibraryDestroy?: () => void,
) {
	const guild: Guild = channel.guild;
	const client = guild.client;
	const userId = client.user?.id;
	if (!userId) throw new Error("The client is not logged in yet");

	return new Promise<void>((resolve, reject) => {
		let sessionId: string | undefined;
		let endpoint: string | undefined;
		let token: string | undefined;
		/**
		 * Updates that arrive before the join payload describe the session being
		 * torn down, whose token is already spent. Taking them would hand the
		 * sidecar credentials that are dead on arrival.
		 */
		let joining = false;
		let settled = false;
		/** Set while the old voice state is being stood down before joining. */
		let leaving = false;
		let leaveTimer: ReturnType<typeof setTimeout> | undefined;

		const adapter = guild.voiceAdapterCreator({
			onVoiceStateUpdate: (state) => {
				if (state.user_id !== userId) return;
				if (!joining) {
					// The leave landed. Waiting for this rather than for a fixed
					// delay is what makes the rejoin reliable: the gateway only
					// mints a token for a session it considers new, and how long
					// it takes to forget the old one is not ours to guess.
					if (leaving && !state.channel_id) {
						leaving = false;
						clearTimeout(leaveTimer);
						join();
					}
					return;
				}
				sessionId = state.session_id ?? undefined;
				ready();
			},
			onVoiceServerUpdate: (server) => {
				if (!joining) return;
				endpoint = server.endpoint ?? undefined;
				token = server.token;
				ready();
			},
			destroy: () => {
				// The caller decides, because by the time this fires the guild
				// may belong to a newer join than this one.
				if (onLibraryDestroy) return onLibraryDestroy();
				sidecar().send({ type: "disconnect", guildId: guild.id });
			},
		});

		/** Op 4 with no channel: leave the guild's voice entirely. */
		function leave() {
			adapter.sendPayload({
				op: 4,
				d: {
					guild_id: guild.id,
					channel_id: null,
					self_mute: false,
					self_deaf: deaf,
				},
			});
		}

		const timer = setTimeout(() => {
			settled = true;
			clearTimeout(leaveTimer);
			// Whatever half a session is left behind would wedge every later
			// attempt the same way, so this stands the guild back down before
			// giving up on it.
			leave();
			adapter.destroy();
			const missing = [
				sessionId ? null : "session id",
				endpoint ? null : "endpoint",
				token ? null : "token",
			]
				.filter(Boolean)
				.join(", ");
			reject(new Error(`Timed out joining voice in ${guild.id} (no ${missing})`));
		}, 15_000);

		function ready() {
			// Both halves are needed, and they arrive in either order.
			if (settled || !sessionId || !endpoint || !token) return;
			settled = true;
			clearTimeout(timer);
			const client = sidecar();
			client.send({
				type: "connect",
				guildId: guild.id,
				channelId: channel.id,
				userId: userId as string,
				sessionId,
				endpoint,
				token,
			});
			// Sent straight after connect rather than waiting for a ready
			// event: the sidecar queues commands per guild, so this is applied
			// before the first frame either way.
			client.send({ type: "setFades", guildId: guild.id, ...fadeSettings() });
			resolve();
		}

		function join() {
			if (settled) return;
			joining = true;
			const sent = adapter.sendPayload({
				op: 4,
				d: {
					guild_id: guild.id,
					channel_id: channel.id,
					self_mute: false,
					self_deaf: deaf,
				},
			});
			if (!sent) {
				settled = true;
				clearTimeout(timer);
				adapter.destroy();
				reject(new Error(`Shard for ${guild.id} is not available`));
			}
		}

		// Discord only mints a voice token for a *new* session. Asking to join
		// while the gateway still holds a voice state for this bot — a channel
		// move, or a restart that left the old state standing — is answered
		// with a state update and no server update, so the handshake never
		// completes. Standing the old session down first is what makes the
		// token arrive.
		if (guild.members.me?.voice.channelId) {
			leaving = true;
			leave();
			// The state update is the signal; this is only the backstop for a
			// leave the gateway never reports.
			leaveTimer = setTimeout(() => {
				leaving = false;
				join();
			}, VOICE_STATE_RESET_MS);
		} else {
			join();
		}
	});
}
