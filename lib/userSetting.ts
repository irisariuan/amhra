import { settingStore } from "./settingStore";
import type { VoiceLanguage } from "./voice/voiceSetting";

/** What each user has chosen for themselves, in every guild. */
export interface UserSetting {
	/**
	 * Post what the bot heard after this user said its name, every time:
	 * "listening…" at once, then the words. Their own choice, since it puts
	 * what they said in the channel.
	 */
	showTranscript?: boolean;
	/**
	 * Hear the bot say what it does for this user's voice commands, where the
	 * bot speaks at all. On unless they turn it off.
	 */
	spokenAnswers?: boolean;
	/**
	 * The language to hear this user in and answer them in, instead of guessing
	 * it from each command. Mandarin and Cantonese are separate: the recogniser
	 * is told which, and each has its own voice.
	 */
	voiceLanguage?: VoiceLanguage;
}

const store = settingStore<UserSetting>(`${process.cwd()}/data/userSetting.json`);

export const userSetting = store.get;
export const setUserSetting = store.set;
