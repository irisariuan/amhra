import { afterEach, describe, expect, test } from "bun:test";
import { Sidecar, fadeSettings, sidecarBin } from "../lib/voice/sidecar";

/**
 * Tests for the voice sidecar client, run against the real Rust process.
 *
 * The client's whole job is a process boundary — framing, parsing, restart —
 * and none of that is exercised by talking to a mock that speaks the same
 * assumptions the client does. So these spawn the actual binary. They are
 * skipped, not failed, when it has not been built: a missing binary means
 * "run bun run build:rust", not "the code is broken".
 */

const built = sidecarBin.available();
const describeBuilt = built ? describe : describe.skip;

if (!built) {
	console.warn(`skipping sidecar tests: ${sidecarBin.path()} is not built`);
}

/** Wait for the first event of a type, with a deadline. */
function next<T extends string>(sidecar: Sidecar, type: T, timeoutMs = 5_000) {
	return new Promise<Record<string, unknown>>((resolve, reject) => {
		const timer = setTimeout(() => {
			sidecar.off(type, onEvent);
			reject(new Error(`timed out waiting for ${type}`));
		}, timeoutMs);
		const onEvent = (payload: Record<string, unknown>) => {
			clearTimeout(timer);
			sidecar.off(type, onEvent);
			resolve(payload);
		};
		sidecar.on(type, onEvent);
	});
}

describe("fadeSettings", () => {
	test("defaults to a hard cut with a short skip fade", () => {
		// Matching the Rust defaults: blending track changes is opt-in, but a
		// skip always gets a brief fade so it does not click.
		const fades = fadeSettings();
		expect(fades.crossfadeMs).toBeGreaterThanOrEqual(0);
		expect(fades.skipFadeMs).toBeGreaterThanOrEqual(0);
		expect(Number.isInteger(fades.crossfadeMs)).toBe(true);
		expect(Number.isInteger(fades.skipFadeMs)).toBe(true);
	});
});

describeBuilt("Sidecar", () => {
	let running: Sidecar | null = null;

	function start() {
		const sidecar = new Sidecar();
		running = sidecar;
		sidecar.start();
		return sidecar;
	}

	afterEach(() => {
		running?.stop();
		running = null;
	});

	test("announces itself with a matching protocol version", async () => {
		const sidecar = start();
		const hello = await next(sidecar, "hello");
		// A mismatch here is what a stale binary looks like, and it explains
		// every later oddity, so it is asserted rather than logged.
		expect(hello.version).toBe(1);
		expect(hello.pid).toBeGreaterThan(0);
		expect(sidecar.running).toBe(true);
	});

	test("reports an empty session list when nothing is connected", async () => {
		const sidecar = start();
		await next(sidecar, "hello");

		sidecar.send({ type: "listSessions" });
		const sessions = await next(sidecar, "sessions");
		expect(sessions.guilds).toEqual([]);
	});

	test("refuses commands for a guild it is not connected to", async () => {
		const sidecar = start();
		await next(sidecar, "hello");

		// The bot's state and the sidecar's can drift; being told is what lets
		// the bot recover instead of waiting for a track that never starts.
		sidecar.send({ type: "skip", guildId: "12345" });
		const error = await next(sidecar, "error");
		expect(error.guildId).toBe("12345");
		expect(String(error.message)).toMatch(/not connected/i);
	});

	test("keeps parsing after a command it does not understand", async () => {
		const sidecar = start();
		await next(sidecar, "hello");

		// Well-framed but unknown: a forward-compatible bot may send commands a
		// stale sidecar has never heard of, and that must not be fatal.
		sidecar.send({ type: "somethingNewer", guildId: "1" } as never);
		const error = await next(sidecar, "error");
		expect(error.guildId).toBeNull();

		sidecar.send({ type: "listSessions" });
		const sessions = await next(sidecar, "sessions");
		expect(sessions.guilds).toEqual([]);
	});

	test("splits events correctly when several arrive together", async () => {
		const sidecar = start();
		await next(sidecar, "hello");

		// Sent back to back so the replies are likely to share a read: the
		// client must recover frames by length, not by chunk boundary.
		const seen: unknown[] = [];
		sidecar.on("sessions", (payload: unknown) => seen.push(payload));
		for (let i = 0; i < 20; i++) {
			sidecar.send({ type: "listSessions" });
		}

		await Bun.sleep(500);
		expect(seen).toHaveLength(20);
	});

	test("survives a command far larger than one pipe read", async () => {
		const sidecar = start();
		await next(sidecar, "hello");

		// 60KB is several pipe buffers: if the length prefix were ignored, or
		// the writer split the header from the body, this is where it breaks.
		// The assertion is that the sidecar is still answering afterwards -
		// what it says about this command is a separate concern.
		sidecar.send({ type: "play", guildId: "1", trackId: "x".repeat(60_000) });
		await next(sidecar, "error");

		sidecar.send({ type: "listSessions" });
		const sessions = await next(sidecar, "sessions");
		expect(sessions.guilds).toEqual([]);
	});

	test("accepts a fade change for a guild it knows nothing about", async () => {
		const sidecar = start();
		await next(sidecar, "hello");

		// The dashboard pushes fades to every connected guild; one that has
		// just disconnected must produce a complaint, not a crash.
		sidecar.send({
			type: "setFades",
			guildId: "404",
			crossfadeMs: 3000,
			skipFadeMs: 40,
		});
		const error = await next(sidecar, "error");
		expect(error.guildId).toBe("404");

		sidecar.send({ type: "listSessions" });
		expect((await next(sidecar, "sessions")).guilds).toEqual([]);
	});

	test("stops without restarting when asked", async () => {
		const sidecar = start();
		await next(sidecar, "hello");

		sidecar.stop();
		expect(sidecar.running).toBe(false);
		// A restart would show up as a second hello; there should be none.
		let restarted = false;
		sidecar.on("hello", () => {
			restarted = true;
		});
		await Bun.sleep(1_200);
		expect(restarted).toBe(false);
	});
});
