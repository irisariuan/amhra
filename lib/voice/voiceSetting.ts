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
	const args = [
		"--voice-commands",
		"--wake-model",
		setting.VOICE_WAKE_MODEL ?? "models/voice/kws-emhara",
		"--wake-keywords",
		setting.VOICE_WAKE_KEYWORDS ?? "training/wake/keywords.txt",
	];
	if (collectsWakeClips(setting)) args.push("--wake-clips", WAKE_CLIPS_DIR);
	if (setting.VOICE_WAKE_CHIME !== false) args.push("--wake-chime");
	const duck = setting.VOICE_DUCK_VOLUME ?? DEFAULT_DUCK_VOLUME;
	if (duck < 1) args.push("--wake-duck", String(Math.max(0, duck)));
	if (setting.VOICE_RECOGNISER_PROVIDER) {
		args.push("--recogniser-provider", setting.VOICE_RECOGNISER_PROVIDER);
	}
	const threads = setting.VOICE_RECOGNISER_THREADS;
	if (threads !== undefined && Number.isInteger(threads) && threads >= 1) {
		args.push("--recogniser-threads", String(threads));
	}
	return args;
}
