import { type ChildProcess, spawn } from "node:child_process";
import { dcb, globalApp } from "../misc";
import { readSetting, type Setting } from "../setting";

/**
 * The voice command model's server, started by the bot itself.
 *
 * When `VOICE_INTENT_MODEL_URL` is on this machine and nothing answers there,
 * the bot runs the server as a child process on that port, restarts it if it
 * dies, and stops it on exit. On Apple silicon that is `mlx_lm.server`
 * through `uv`; anywhere else, llama.cpp's `llama-server`, which runs on a
 * plain CPU. `VOICE_INTENT_PROVIDER` "cpu" runs `llama-server` with no layers
 * on the GPU, on Apple silicon too, and "gpu" all of them; MLX is always on
 * the GPU. Either fetches the model itself the first time, which can take
 * minutes; until it answers, commands are read by the fallback.
 *
 * A server that already answers on the port — started by hand, LM Studio, or
 * one an earlier run of the bot left behind — is used as it is.
 */

/** Restart backoff bounds after an unexpected exit. */
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
/** How often to look for the server answering while it starts. */
const POLL_MS = 1000;
/** Enough for the instructions and a command, and small enough for a Pi. */
const CONTEXT_TOKENS = 4096;
/**
 * For a model that also hears the command: llama-server's slots share the
 * context, and the audio is in one while the instructions are in another.
 */
const AUDIO_CONTEXT_TOKENS = 8192;
/**
 * The most a Gemma may think over one command, in tokens, before it is made
 * to answer. It decides how much of that to use: a word or two of Cantonese
 * took it 80, a song to find more than 300.
 */
export const THINKING_TOKENS = 1024;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Where the model runs, as far as the bot can choose: unset leaves it to the
 * runtime. Core ML runs neither, so it is the CPU.
 */
export type IntentRuntime = "cpu" | "gpu" | undefined;

export function intentRuntime(setting: Setting = readSetting()): IntentRuntime {
	const provider = setting.VOICE_INTENT_PROVIDER;
	return provider === "coreml" ? "cpu" : provider;
}

/** Qwen3 4B, in the runtime this machine will serve it with. */
export function defaultIntentModel(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	runtime: IntentRuntime = undefined,
) {
	return usesMlx(platform, arch, runtime) ? "mlx-community/Qwen3-4B-4bit" : "Qwen/Qwen3-4B-GGUF:Q4_K_M";
}

/** Where the bot starts a server when it needs one and was not told where. */
export const DEFAULT_MODEL_URL = "http://127.0.0.1:8085/v1";

/**
 * Gemma 4 as llama.cpp fetches it, for a Gemma `VOICE_RECOGNISER`; null for
 * any other. Q4_0 is named because the repositories have no Q4_K_M, and
 * llama.cpp would then take their first file, the full-precision one.
 */
export function gemmaModel(setting: Setting = readSetting()) {
	switch (setting.VOICE_RECOGNISER) {
		case "gemma-4-E2B":
			return "ggml-org/gemma-4-E2B-it-GGUF:Q4_0";
		case "gemma-4-E4B":
			return "ggml-org/gemma-4-E4B-it-GGUF:Q4_0";
		default:
			return null;
	}
}

/**
 * The server voice commands use and the model it should have, if there is
 * to be one. `audio` when the model is also the recogniser, and so has to be
 * served by something that passes audio on: `llama-server`, not MLX's.
 * `thinking` when it may be asked to think over a command it made nothing of.
 */
export function modelEndpoint(
	setting: Setting = readSetting(),
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): { url: string; model: string; audio: boolean; thinking: boolean } | null {
	const gemma = gemmaModel(setting);
	const url = setting.VOICE_INTENT_MODEL_URL || (gemma ? DEFAULT_MODEL_URL : undefined);
	if (!url) return null;
	const model = setting.VOICE_INTENT_MODEL ?? gemma ?? defaultIntentModel(platform, arch, intentRuntime(setting));
	// Only a Gemma is asked to think: Qwen3's instructions end in "/no_think".
	return { url, model, audio: gemma !== null, thinking: gemma !== null && setting.VOICE_INTENT_THINKING !== false };
}

/** MLX has no CPU-only mode worth having, so the CPU is llama.cpp's. */
function usesMlx(platform: NodeJS.Platform, arch: string, runtime: IntentRuntime) {
	return platform === "darwin" && arch === "arm64" && runtime !== "cpu";
}

export type Launch = { command: string; args: string[] };

/**
 * How to run the server `url` names, or null when it is not on this machine
 * and so not the bot's to start.
 */
export function launchFor(
	url: string,
	model: string,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	runtime: IntentRuntime = undefined,
	audio = false,
	thinking = false,
): Launch | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (!LOOPBACK.has(parsed.hostname)) return null;
	const host = parsed.hostname.replace(/^\[|\]$/g, "");
	const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
	// `mlx_lm.server` takes text only.
	if (!audio && usesMlx(platform, arch, runtime)) {
		return {
			command: "uv",
			args: [
				"run", "-q", "--python", "3.12", "--with", "mlx-lm",
				"mlx_lm.server", "--model", model, "--host", host, "--port", port,
			],
		};
	}
	return {
		command: "llama-server",
		// The alias makes the name the bot asks for the name it serves.
		args: [
			"-hf", model, "--alias", model, "--host", host, "--port", port,
			"-c", String(audio ? AUDIO_CONTEXT_TOKENS : CONTEXT_TOKENS),
			// Gemma thinks before it answers unless told not to, and the
			// "/no_think" the instructions end with is Qwen3's. Allowed to,
			// it is stopped at a limit, so that it always gets to answer:
			// with none it thought its whole answer away.
			...(audio ? (thinking ? ["--reasoning-budget", String(THINKING_TOKENS)] : ["--reasoning", "off"]) : []),
			...(runtime ? ["-ngl", runtime === "cpu" ? "0" : "999"] : []),
		],
	};
}

/** Something at `url` answers as an OpenAI-compatible server with its model loaded. */
async function answers(url: string) {
	try {
		const response = await fetch(`${url.replace(/\/+$/, "")}/models`, {
			signal: AbortSignal.timeout(POLL_MS),
		});
		return response.ok;
	} catch {
		return false;
	}
}

export class IntentServer {
	private child: ChildProcess | null = null;
	private backoff = MIN_BACKOFF_MS;
	private stopping = false;
	/** The runtime is not installed, so starting it again would not help. */
	private missing = false;
	private looking = false;
	/** Answering, so commands can be sent to it. */
	ready = false;

	constructor(
		private readonly url: string,
		private readonly launch: Launch,
	) {}

	async start() {
		if (this.child || this.stopping || this.missing || this.looking) return;
		this.looking = true;
		const there = await answers(this.url);
		this.looking = false;
		if (this.child || this.stopping) return;
		if (there) {
			this.ready = true;
			dcb.log(`Voice command model already answers at ${this.url}`);
			return;
		}

		const { command, args } = this.launch;
		dcb.log(`Starting voice command model: ${command} ${args.join(" ")}`);
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			// Its own process group, so stopping it also stops what uv starts.
			detached: true,
			env: { ...process.env, HF_HUB_DISABLE_PROGRESS_BARS: "1" },
		});
		this.child = child;

		const relay = (chunk: Buffer) => {
			for (const line of chunk.toString().split(/[\r\n]+/)) {
				if (line.trim()) dcb.log(`intent model: ${line.trim()}`);
			}
		};
		child.stdout?.on("data", relay);
		child.stderr?.on("data", relay);
		child.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") {
				this.missing = true;
				globalApp.err(
					`Voice command model could not start: \`${command}\` is not installed. ${
						command === "uv"
							? "Install uv (https://docs.astral.sh/uv/)"
							: "Install llama.cpp (https://github.com/ggml-org/llama.cpp)"
					}, or set VOICE_INTENT_MODEL_SERVE to false. Using command names until then.`,
				);
			} else {
				globalApp.err(`Voice command model failed to run: ${command}`, error);
			}
		});
		child.on("close", (code) => {
			if (this.child !== child) return;
			this.child = null;
			this.ready = false;
			if (this.stopping || this.missing) return;
			globalApp.warn(`Voice command model exited (${code}), restarting in ${this.backoff}ms`);
			setTimeout(() => this.start(), this.backoff);
			this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
		});

		this.waitUntilReady(child);
	}

	/** Look until it answers, or until it has gone. */
	private async waitUntilReady(child: ChildProcess) {
		while (this.child === child) {
			if (await answers(this.url)) {
				if (this.child !== child) return;
				this.ready = true;
				this.backoff = MIN_BACKOFF_MS;
				dcb.log(`Voice command model ready at ${this.url}`);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
	}

	/**
	 * A command went unanswered. A server the bot did not start may have
	 * gone; one it did start is restarted when it exits.
	 */
	notAnswering() {
		if (this.child) return;
		this.ready = false;
		this.start();
	}

	/** Stop without restarting. */
	stop() {
		this.stopping = true;
		this.ready = false;
		const child = this.child;
		this.child = null;
		if (!child?.pid) return;
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			child.kill("SIGTERM");
		}
	}
}

let shared: IntentServer | null = null;

/** The server the bot looks after, if it has one. */
export function intentServer() {
	return shared;
}

/**
 * Start looking after the voice command model's server, when there is one to
 * look after: the URL is set or the recogniser is a Gemma, it is on this
 * machine, and serving is not turned off.
 */
export function startIntentServer(setting: Setting = readSetting()) {
	if (shared) return shared;
	const endpoint = modelEndpoint(setting);
	if (!endpoint || setting.VOICE_INTENT_MODEL_SERVE === false) return null;
	const { url, model, audio, thinking } = endpoint;
	const runtime = intentRuntime(setting);
	if (setting.VOICE_INTENT_PROVIDER === "coreml") {
		globalApp.warn("Voice command model: neither MLX nor llama.cpp runs on Core ML; running it on the cpu");
	}
	const launch = launchFor(url, model, process.platform, process.arch, runtime, audio, thinking);
	if (!launch) return null;
	shared = new IntentServer(url, launch);
	shared.start();
	return shared;
}

export function stopIntentServer() {
	shared?.stop();
	shared = null;
}
