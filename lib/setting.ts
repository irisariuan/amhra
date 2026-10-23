import { writeFileSync, readFileSync } from "node:fs";
import { reloadLanguages } from "./language";

let setting: Setting | null = null;

export function readSetting(
	file = `${process.cwd()}/data/setting.json`,
): Setting {
	if (setting === null) {
		setting = JSON.parse(readFileSync(file, "utf8"));
	}
	return setting ?? JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Use these settings rather than data/setting.json, which the setup tool
 * writes and git ignores. For tests on a checkout without one.
 */
export function provideSetting(next: Setting) {
	setting = next;
}

export function reloadSetting(
	reloadLanguage = true,
	file = `${process.cwd()}/data/setting.json`,
) {
	const nextSetting = JSON.parse(readFileSync(file, "utf8")) as Setting;
	// Modules commonly retain the object returned by readSetting(). Update that
	// object instead of replacing it so a runtime reload reaches those modules.
	if (setting) Object.assign(setting, nextSetting);
	else setting = nextSetting;
	if (reloadLanguage) reloadLanguages();
	return setting;
}

export function writeJsonSync(file: string, data: object) {
	return writeFileSync(file, JSON.stringify(data, null, 4));
}

export type LogFile = "errim" | "error" | "errwn" | "express" | "main";

/**
 * Everything the bot is configured with, except credentials.
 *
 * Tokens live in `.env` and are read through `lib/secrets.ts`: this file is
 * edited from the dashboard, served to it as a schema, and written by the setup
 * tools, so it is the wrong place for anything bearer-shaped.
 */
export interface Setting {
	CLIENT_ID: string;
	TEST_CLIENT_ID: string;

	QUEUE_SIZE: number;
	HTTPS: boolean;
	PORT: number;
	RATE_LIMIT: number;
	REDIRECT_URI: string;
	WEBSITE?: null | string;

	PRELOAD: LogFile[];
	DETAIL_LOGGING: boolean;
	USE_YOUTUBE_DL: boolean;
	/** Download through the Rust fetcher instead of yt-dlp */
	USE_NATIVE_FETCH?: boolean;
	/** Override the amhra-fetch binary path; defaults to the cargo build output */
	NATIVE_FETCH_BIN?: string;
	/** Play through the Rust voice sidecar instead of @discordjs/voice */
	USE_RUST_VOICE?: boolean;
	/**
	 * With USE_RUST_VOICE, have the sidecar stream each track straight from
	 * YouTube into the voice connection instead of downloading it into the
	 * cache first. Nothing is written to disk; a track is held in memory while
	 * it plays, so it can still seek both ways, and freed when it ends.
	 */
	NATIVE_NO_CACHE?: boolean;
	/**
	 * Overlap between one track and the next, in milliseconds. Zero is a hard
	 * cut. Only the Rust voice path can blend; the legacy path ignores it.
	 */
	CROSSFADE_IN_MS?: number;
	/**
	 * Overlap when a listener skips, in milliseconds. Kept separate from
	 * CROSSFADE_IN_MS because a skip should feel immediate rather than mixed.
	 */
	SKIP_FADE_IN_MS?: number;
	/** Override the amhra-sidecar binary path; defaults to the cargo build output */
	NATIVE_VOICE_BIN?: string;
	SEEK: boolean;
	AUTO_LEAVE: number;
	/**
	 * Time in ms the bot may sit in a voice channel with nobody else in it,
	 * playing or not. Negative disables it. Defaults to a minute.
	 */
	AUTO_LEAVE_ALONE?: number;
	PREFIX: string;
	USE_COOKIES: boolean;
	MAX_CACHE_IN_GB: number;
	/** Seconds of already-played audio kept in memory for instant backward seek */
	MAX_REPLAY_BUFFER_IN_SEC?: number;
	/** Memory budget for not-yet-played audio; past it the cache file is re-read */
	MAX_STREAM_BUFFER_IN_MB?: number;

	VOLUME_MODIFIER: number;
	BANNED_IDS: string[];
	MESSAGE_LOGGING?: boolean;
	VOICE_LOGGING?: boolean;
	/**
	 * Schedule an upcoming premiere to cut in when it starts, instead of
	 * refusing it, when one is played. Defaults to on.
	 */
	AUTO_SCHEDULE_PREMIERES?: boolean;
	/**
	 * Shift applied to every synced lyric line, in milliseconds. Positive shows
	 * lines later, negative sooner. Defaults to zero.
	 */
	LYRICS_DELAY_MS?: number;

	/**
	 * Let guilds turn on voice commands. Off by default: it needs the Rust
	 * sidecar built with voice commands, and its models hold about 570MB.
	 * Each guild still opts in with /voicecommands. Read when the sidecar
	 * starts.
	 */
	VOICE_COMMANDS?: boolean;
	/** The fine-tuned wake model; defaults to models/voice/kws-emhara */
	VOICE_WAKE_MODEL?: string;
	/** Its wake phrases; defaults to training/wake/keywords.txt */
	VOICE_WAKE_KEYWORDS?: string;
	/**
	 * The wake word classifier from training/wake/classifier/export.py, e.g.
	 * models/voice/wake-classifier, to hear the name with instead of the wake
	 * model; VOICE_WAKE_MODEL and VOICE_WAKE_KEYWORDS are then unused. Unset
	 * by default: it is an experiment.
	 */
	VOICE_WAKE_CLASSIFIER?: string;
	/**
	 * Keep the audio around each wake, from guilds with voice commands on, for
	 * retraining the wake model. On unless set to false; members are told.
	 */
	VOICE_COLLECT_WAKE_CLIPS?: boolean;
	/**
	 * Log what was heard after the name, for tuning the command matching. Off
	 * unless set: it writes what people said into the bot's log.
	 */
	VOICE_LOG_TRANSCRIPTS?: boolean;
	/**
	 * Say aloud what a voice command does: "Skipping.", "Playing bad guy.", in
	 * the language of the command. Off unless set. Uses whichever speech
	 * models `scripts/download-voice-models.sh --speech` put in models/voice.
	 * A model is loaded only to make a phrase not said before, and the fixed
	 * ones are saved under the cache, so it costs little after the first run;
	 * see the sidecar's `speech` module.
	 */
	VOICE_SPEECH?: boolean;
	/** CPU threads for making speech. Defaults to 1. */
	VOICE_SPEECH_THREADS?: number;
	/** Where speech is made, as `VOICE_RECOGNISER_PROVIDER`. Defaults to the CPU. */
	VOICE_SPEECH_PROVIDER?: ModelProvider;
	/** Chime in the call when the bot hears its name. On unless false. */
	VOICE_WAKE_CHIME?: boolean;
	/**
	 * The music's volume, as a fraction, from the name until the command has
	 * been heard. Defaults to 0.3; 1 leaves it alone.
	 */
	VOICE_DUCK_VOLUME?: number;
	/**
	 * Where speech recognition runs. Core ML needs a sidecar built with
	 * `--features shared-onnxruntime`, on macOS; "gpu" is CUDA, and needs one
	 * built with `--features cuda-onnxruntime` against a sherpa-onnx GPU
	 * release. Otherwise it says so and stays on the CPU. Defaults to the
	 * CPU, which measured faster.
	 */
	VOICE_RECOGNISER_PROVIDER?: ModelProvider;
	/**
	 * Where the keyword spotter that hears the name runs, as
	 * `VOICE_RECOGNISER_PROVIDER`. The wake classifier only runs on the CPU.
	 * Defaults to the CPU.
	 */
	VOICE_WAKE_PROVIDER?: ModelProvider;
	/** Threads for speech recognition. Defaults to 2. */
	VOICE_RECOGNISER_THREADS?: number;
	/**
	 * The language speech recognition listens for, in every server. "auto"
	 * (the default) guesses per command and takes short ones for the wrong
	 * language now and then; pinned, the others are not understood.
	 */
	VOICE_LANGUAGE?: "auto" | "en" | "zh" | "ja" | "ko" | "yue";
	/**
	 * How long after the name to wait for a command to start, in ms. Until
	 * something is said after the chime, a pause does not end the command
	 * either. Defaults to 2500.
	 */
	VOICE_WAIT_FOR_COMMAND_MS?: number;
	/** Silence that ends a command, in ms. Defaults to 500. */
	VOICE_END_SILENCE_MS?: number;
	/** The longest command, in ms. Defaults to 8000. */
	VOICE_MAX_COMMAND_MS?: number;
	/**
	 * An OpenAI-compatible server on this machine, as `http://host:port/v1`,
	 * whose model decides what every voice command asks for. Unset, or when
	 * the server does not answer, only command names said first are understood.
	 */
	VOICE_INTENT_MODEL_URL?: string;
	/**
	 * The model that server should use. Defaults to Qwen3 4B: in MLX on Apple
	 * silicon, as a llama.cpp GGUF elsewhere.
	 */
	VOICE_INTENT_MODEL?: string;
	/**
	 * Start that server when the URL is on this machine and nothing answers
	 * there: `mlx_lm.server` on Apple silicon, llama.cpp's `llama-server`
	 * elsewhere. On unless set to false.
	 */
	VOICE_INTENT_MODEL_SERVE?: boolean;
	/**
	 * Where the server the bot starts runs the model: "cpu" is `llama-server`
	 * with no layers on the GPU (on Apple silicon too, instead of MLX, so a
	 * VOICE_INTENT_MODEL set to an MLX model will not load), "gpu" all of
	 * them, and "coreml", which neither runs, the CPU. Unset leaves it to the
	 * runtime: MLX on Apple silicon, llama.cpp's own choice elsewhere.
	 */
	VOICE_INTENT_PROVIDER?: ModelProvider;
}

/** Where a model runs. */
export type ModelProvider = "cpu" | "gpu" | "coreml";
