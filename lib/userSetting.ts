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
	 * The languages this user speaks, the likeliest first, Mandarin and Cantonese
	 * apart. The model goes by them to decide what to have them heard in again;
	 * only one, and the recogniser just hears them in it.
	 */
	voiceLanguages?: VoiceLanguage[];
	/**
	 * The language to answer this user in, whichever they spoke. Unset, in the
	 * one heard. Mandarin and Cantonese are separate: each has its own voice.
	 */
	voiceOutputLanguage?: VoiceLanguage;
}

const store = settingStore<UserSetting>(`${process.cwd()}/data/userSetting.json`);

export const userSetting = store.get;
export const setUserSetting = store.set;
