import { settingStore } from "./settingStore";

/** What each user has chosen for themselves, in every guild. */
export interface UserSetting {
	/**
	 * Post what the bot heard after this user said its name, every time:
	 * "listening…" at once, then the words. Their own choice, since it puts
	 * what they said in the channel.
	 */
	showTranscript?: boolean;
}

const store = settingStore<UserSetting>(`${process.cwd()}/data/userSetting.json`);

export const userSetting = store.get;
export const setUserSetting = store.set;
