import type { VoiceState } from "discord.js";
import type { CustomClient } from "../custom";
import { guildSetting } from "../guildSetting";
import { dcb } from "../misc";
import { getAudioPlayer, getConnection, joinVoice } from "./core";
import { guildLanguage } from "./voiceCommands";

let boundClient: CustomClient | null = null;

/**
 * Follow members into voice, in guilds that turned on `/autojoin`.
 *
 * Only an idle bot follows: one already in a channel of the guild stays put,
 * so someone opening a second call never pulls it away from the first. Call
 * once at boot.
 */
export function bindAutoJoin(client: CustomClient) {
	if (boundClient === client) return;
	boundClient = client;
	client.on("voiceStateUpdate", (before, after) => follow(client, before, after));
}

function follow(client: CustomClient, before: VoiceState, after: VoiceState) {
	const channel = after.channel;
	if (!channel || before.channelId === after.channelId) return;
	if (after.member?.user.bot) return;
	const guild = after.guild;
	if (!guildSetting(guild.id).autoJoin) return;
	if (channel.id === guild.afkChannelId || !channel.joinable) return;
	// The connection is registered the moment a join starts, so two members
	// arriving together still make one join between them.
	if (getConnection(guild.id) || guild.members.me?.voice.channelId) return;

	dcb.log(`(Guild ID: ${guild.id}) Auto-joining ${channel.id}`);
	const connection = joinVoice(channel, guild);
	const player = getAudioPlayer(client, guild.id, channel, guildLanguage(guild));
	if (player) connection.subscribe(player);
}
