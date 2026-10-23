import { guildSetting } from "../guildSetting";
import { readSetting, type Setting } from "../setting";

/**
 * Who may be heard, decided from the settings alone. Kept apart from the code
 * that acts on what is heard so the sidecar client can ask without importing
 * the player.
 */

/** How far the music drops while someone is giving a command. */
export const DEFAULT_DUCK_VOLUME = 0.3;

/** Where the sidecar puts the wake clips, relative to where it starts. */
export const WAKE_CLIPS_DIR = "data/recordings/wake-clips";

/** The bot's owner allows voice commands at all. */
export function voiceCommandsAllowed(setting: Setting = readSetting()) {
	return setting.VOICE_COMMANDS === true;
}

/** Wake clips are kept. On unless switched off, and only where voice commands are. */
export function collectsWakeClips(setting: Setting = readSetting()) {
	return voiceCommandsAllowed(setting) && setting.VOICE_COLLECT_WAKE_CLIPS !== false;
}

/** The bot says aloud what it does for a voice command. Off unless set. */
export function speaksAnswers(setting: Setting = readSetting()) {
	return voiceCommandsAllowed(setting) && setting.VOICE_SPEECH === true;
}

/** The guild has opted in, and the bot allows it. */
export function guildListens(guildId: string, setting: Setting = readSetting()) {
	return voiceCommandsAllowed(setting) && guildSetting(guildId).voiceCommands === true;
}

/**
 * The sidecar's flags for voice commands, or none when they are not allowed.
 *
 * Starting with them costs every guild the models' memory, but hears nothing
 * by itself: each guild's audio is dropped undecrypted until its own
 * `connect` or `setListen` says it opted in.
 */
export function voiceCommandArgs(setting: Setting = readSetting()): string[] {
	if (!voiceCommandsAllowed(setting)) return [];
	const args = ["--voice-commands"];
	if (setting.VOICE_WAKE_CLASSIFIER) {
		args.push("--wake-classifier", setting.VOICE_WAKE_CLASSIFIER);
	} else {
		args.push(
			"--wake-model",
			setting.VOICE_WAKE_MODEL ?? "models/voice/kws-emhara",
			"--wake-keywords",
			setting.VOICE_WAKE_KEYWORDS ?? "training/wake/keywords.txt",
		);
	}
	if (collectsWakeClips(setting)) args.push("--wake-clips", WAKE_CLIPS_DIR);
	if (setting.VOICE_WAKE_CHIME !== false) args.push("--wake-chime");
	const duck = setting.VOICE_DUCK_VOLUME ?? DEFAULT_DUCK_VOLUME;
	if (duck < 1) args.push("--wake-duck", String(Math.max(0, duck)));
	if (setting.VOICE_RECOGNISER_PROVIDER) {
		args.push("--recogniser-provider", setting.VOICE_RECOGNISER_PROVIDER);
	}
	if (setting.VOICE_LANGUAGE && setting.VOICE_LANGUAGE !== "auto") {
		args.push("--recogniser-language", setting.VOICE_LANGUAGE);
	}
	const threads = setting.VOICE_RECOGNISER_THREADS;
	if (threads !== undefined && Number.isInteger(threads) && threads >= 1) {
		args.push("--recogniser-threads", String(threads));
	}
	if (speaksAnswers(setting)) {
		args.push("--speech");
		const threads = setting.VOICE_SPEECH_THREADS;
		if (threads !== undefined && Number.isInteger(threads) && threads >= 1) {
			args.push("--speech-threads", String(threads));
		}
	}
	const { waitForSpeechMs, endSilenceMs, maxCaptureMs } = voiceTimings(setting);
	const timings = [
		["--wait-for-speech-ms", waitForSpeechMs],
		["--end-silence-ms", endSilenceMs],
		["--max-capture-ms", maxCaptureMs],
	] as const;
	for (const [flag, ms] of timings) {
		if (ms !== null) args.push(flag, String(ms));
	}
	return args;
}

/**
 * How long voice commands wait, in ms, as the sidecar's `setTimings` takes
 * them: after the name for a command, the silence that ends one, and the
 * longest one. Null where unset, for the sidecar's default.
 */
export function voiceTimings(setting: Setting = readSetting()) {
	const ms = (value: number | undefined) =>
		value !== undefined && Number.isInteger(value) && value > 0 ? value : null;
	return {
		waitForSpeechMs: ms(setting.VOICE_WAIT_FOR_COMMAND_MS),
		endSilenceMs: ms(setting.VOICE_END_SILENCE_MS),
		maxCaptureMs: ms(setting.VOICE_MAX_COMMAND_MS),
	};
}
