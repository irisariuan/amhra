import { settingStore } from "./settingStore";

/** What each guild has chosen for itself. */
export interface GuildSetting {
	/** Listen for the bot's name in this guild's voice channels. */
	voiceCommands?: boolean;
	/** Join a member's voice channel as they enter it, when in no other. */
	autoJoin?: boolean;
}

const store = settingStore<GuildSetting>(`${process.cwd()}/data/guildSetting.json`);

export const guildSetting = store.get;
export const setGuildSetting = store.set;
