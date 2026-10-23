import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { defaultIntentModel, IntentServer, launchFor } from "../lib/voice/intentServer";

/**
 * The bot starting the voice command model's server itself, so nobody has to
 * keep one running beside it.
 */

describe("what it runs", () => {
	test("mlx_lm.server through uv on Apple silicon", () => {
		const model = defaultIntentModel("darwin", "arm64");
		expect(model).toBe("mlx-community/Qwen3-4B-4bit");
		expect(launchFor("http://127.0.0.1:8085/v1", model, "darwin", "arm64")).toEqual({
			command: "uv",
			args: [
				"run", "-q", "--python", "3.12", "--with", "mlx-lm",
				"mlx_lm.server", "--model", model, "--host", "127.0.0.1", "--port", "8085",
			],
		});
	});

	test("llama-server anywhere else, serving under the name it is asked for", () => {
		const model = defaultIntentModel("linux", "arm64");
		expect(model).toBe("Qwen/Qwen3-4B-GGUF:Q4_K_M");
		const launch = launchFor("http://localhost:9000/v1/", model, "linux", "arm64");
		expect(launch?.command).toBe("llama-server");
		expect(launch?.args).toEqual([
			"-hf", model, "--alias", model, "--host", "localhost", "--port", "9000", "-c", "4096",
		]);
	});

	test("nothing for a server on another machine, or no URL at all", () => {
		expect(launchFor("http://192.168.1.20:8085/v1", "m", "linux", "arm64")).toBeNull();
		expect(launchFor("not a url", "m", "linux", "arm64")).toBeNull();
	});

	test("the IPv6 loopback is this machine too", () => {
		expect(launchFor("http://[::1]:8085/v1", "m", "linux", "x64")?.args).toContain("::1");
	});
});

/** A port nothing is listening on. */
async function freePort() {
	return new Promise<number>((resolve) => {
		const probe = createServer();
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => resolve(port));
		});
	});
}

/** A stand-in for the model server: answers /v1/models, and its pid. */
function standIn(port: number) {
	return {
		command: process.execPath,
		args: [
			"-e",
			`Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch: () => Response.json({ data: [], pid: process.pid }) });`,
		],
	};
}

async function until(check: () => boolean | Promise<boolean>, ms = 10_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("timed out");
}

async function servingPid(url: string) {
	try {
		const body = (await (await fetch(`${url}/models`)).json()) as { pid: number };
		return body.pid;
	} catch {
		return undefined;
	}
}

describe("looking after it", () => {
	let server: IntentServer | undefined;
	afterEach(() => server?.stop());

	test("starts it, is ready once it answers, and stops it", async () => {
		const port = await freePort();
		const url = `http://127.0.0.1:${port}/v1`;
		server = new IntentServer(url, standIn(port));
		expect(server.ready).toBe(false);
		server.start();
		await until(() => server?.ready === true);
		expect(await servingPid(url)).toBeNumber();

		server.stop();
		await until(async () => (await servingPid(url)) === undefined);
	});

	test("starts it again when it dies", async () => {
		const port = await freePort();
		const url = `http://127.0.0.1:${port}/v1`;
		server = new IntentServer(url, standIn(port));
		server.start();
		await until(() => server?.ready === true);
		const first = (await servingPid(url)) as number;

		process.kill(first, "SIGKILL");
		await until(async () => {
			const pid = await servingPid(url);
			return pid !== undefined && pid !== first;
		});
		await until(() => server?.ready === true);
	});

	test("uses a server that already answers rather than starting another", async () => {
		const port = await freePort();
		const url = `http://127.0.0.1:${port}/v1`;
		const there = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => Response.json({ data: [] }) });
		try {
			server = new IntentServer(url, { command: "/nonexistent/should-not-run", args: [] });
			await server.start();
			expect(server.ready).toBe(true);
		} finally {
			there.stop(true);
		}
	});

	test("gives up, once, when the runtime is not installed", async () => {
		const port = await freePort();
		server = new IntentServer(`http://127.0.0.1:${port}/v1`, {
			command: "/nonexistent/llama-server",
			args: [],
		});
		await server.start();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(server.ready).toBe(false);
		// Not tried again.
		await server.start();
		expect(server.ready).toBe(false);
	});
});
