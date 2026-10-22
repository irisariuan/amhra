import { guildSetting } from "../guildSetting";
import { readSetting, type Setting } from "../setting";

/**
 * Who may be heard, decided from the settings alone. Kept apart from the code
 * that acts on what is heard so the sidecar client can ask without importing
 * the player.
 */

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
	return args;
}
