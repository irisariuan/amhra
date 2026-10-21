import type { CustomClient } from "../custom";
import { dcb } from "../misc";
import { readSetting } from "../setting";
import {
	destroyAudioPlayer,
	disconnectConnection,
	getConnection,
} from "./core";
import { type LeaveLimits, type LeaveReason, planLeave } from "./leavePlan";
import { hasLayers } from "./native";
import { hasSchedule } from "./schedule";

/**
 * Asks every player whether the bot should still be in its voice channel.
 *
 * The decision itself lives in `leavePlan.ts`; this is the part that reads the
 * live state and acts on the answer. It runs on a sweep rather than on armed
 * timers because the two conditions it watches — a player going idle and a
 * channel emptying out — are states, not events, and a state that is re-read
 * cannot be missed. A pause that arms no timer, a timer cleared by the next
 * track, a timer that fires early and gives up: none of those have anywhere to
 * happen here.
 *
 * The interval also bounds how late a departure can be, so it wants to be well
 * under the shortest limit anyone would sensibly configure.
 */
export const SWEEP_INTERVAL_MS = 15_000;

const setting = readSetting();

/** Read per sweep: the dashboard can change these while the bot is running. */
function limits(): LeaveLimits {
	return {
		inactivityMs: setting.AUTO_LEAVE ?? 15 * 60 * 1000,
		aloneMs: setting.AUTO_LEAVE_ALONE ?? 60 * 1000,
	};
}

/**
 * How many people are in the bot's voice channel, not counting bots.
 *
 * Null means the question could not be answered — the bot is not in a channel,
 * or the gateway has not told us about it yet — which the planner is careful
 * to treat as unknown rather than as empty.
 */
export function listenersIn(
	client: CustomClient,
	guildId: string,
): number | null {
	const channel = client.guilds.cache.get(guildId)?.members?.me?.voice?.channel;
	if (!channel) return null;
	return channel.members.filter(member => !member.user.bot).size;
}

function leave(client: CustomClient, guildId: string, reason: LeaveReason) {
	dcb.log(
		`Leaving ${guildId}: ${
			reason === "alone" ? "nobody left in the channel" : "inactive"
		}`,
	);
	// Read before the player goes: in native mode the connection is the
	// sidecar's, and tearing the player down first would lose the handle.
	const connection = getConnection(guildId);
	destroyAudioPlayer(client, guildId);
	if (connection) disconnectConnection(connection);
}

/** One pass over every live player. Exported for tests and manual triggering. */
export function sweepLeave(client: CustomClient, now = Date.now()) {
	const current = limits();
	for (const [guildId, player] of client.player) {
		const plan = planLeave(
			{
				// A paused player is not producing audio, and that is exactly
				// the case the old timers left running forever. Layers keep
				// playing with an empty queue, and pause along with it.
				busy: !player.isPaused && (player.isPlaying || hasLayers(guildId)),
				listeners: listenersIn(client, guildId),
				idleSince: player.idleSince,
				aloneSince: player.aloneSince,
				scheduled: hasSchedule(guildId),
			},
			current,
			now,
		);
		if (plan.action === "wait") {
			player.idleSince = plan.idleSince;
			player.aloneSince = plan.aloneSince;
			continue;
		}
		leave(client, guildId, plan.reason);
	}
	sweepOrphans(client, current, now);
}

/**
 * Guilds where the bot is seated in voice with no player and no connection
 * behind it: a restart while it was in a channel, or a session that dropped
 * under it. Nothing can play there, so these only ever wait out the limits.
 */
const orphans = new Map<string, { idleSince: number | null; aloneSince: number | null }>();

function sweepOrphans(client: CustomClient, current: LeaveLimits, now: number) {
	const seen = new Set<string>();
	for (const [guildId, guild] of client.guilds.cache) {
		if (!guild.members.me?.voice.channelId) continue;
		if (client.player.has(guildId) || getConnection(guildId)) continue;
		seen.add(guildId);
		const carried = orphans.get(guildId);
		const plan = planLeave(
			{
				busy: false,
				listeners: listenersIn(client, guildId),
				idleSince: carried?.idleSince ?? null,
				aloneSince: carried?.aloneSince ?? null,
			},
			current,
			now,
		);
		if (plan.action === "wait") {
			orphans.set(guildId, { idleSince: plan.idleSince, aloneSince: plan.aloneSince });
			continue;
		}
		dcb.log(`Leaving ${guildId}: seated in voice with nothing playing`);
		orphans.delete(guildId);
		guild.shard.send({
			op: 4,
			d: { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false },
		});
	}
	for (const guildId of orphans.keys()) {
		if (!seen.has(guildId)) orphans.delete(guildId);
	}
}

/**
 * Start the sweep. Safe to call once at boot and never think about again: the
 * players it walks are whatever is in `client.player` at the time, so there is
 * nothing to register or clean up when one comes or goes.
 */
export function startLeaveSweeper(
	client: CustomClient,
	intervalMs = SWEEP_INTERVAL_MS,
) {
	const timer = setInterval(() => {
		try {
			sweepLeave(client);
		} catch (error) {
			// A guild that throws must not take the sweep down with it, or one
			// bad player would keep the bot in every other channel forever.
			dcb.log(`Leave sweep failed: ${error}`);
		}
	}, intervalMs);
	timer.unref?.();
	return timer;
}
