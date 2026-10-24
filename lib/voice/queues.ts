import type { CustomAudioPlayer } from "../custom";
import { freeQueueNumber } from "./queuePlan";

/**
 * A guild's queues past the first, by number.
 *
 * Queue 1 stays in `client.player`, where everything that predates the others
 * looks for it. Only the bookkeeping is here, with nothing but types imported,
 * so the player and the sidecar bridge can both reach it without a cycle.
 */
const extras = new Map<string, Map<number, CustomAudioPlayer>>();

/** The guild's queues past the first, in number order. */
export function extraQueues(guildId: string): CustomAudioPlayer[] {
	const queues = extras.get(guildId);
	if (!queues) return [];
	return [...queues.values()].sort((a, b) => a.queueId - b.queueId);
}

/** Queue `n` of the guild, for any `n` above 1. */
export function findQueue(guildId: string, n: number): CustomAudioPlayer | undefined {
	return extras.get(guildId)?.get(n);
}

/** Every guild's queues past the first, for the sweep that ends their gaps. */
export function* allExtraQueues(): Generator<CustomAudioPlayer> {
	for (const queues of extras.values()) yield* queues.values();
}

/**
 * A new queue for the guild, made by `make` under the lowest free number.
 * Null when the guild already has as many as it may.
 */
export function addQueue(guildId: string, make: (n: number) => CustomAudioPlayer) {
	let queues = extras.get(guildId);
	const n = freeQueueNumber(queues?.keys() ?? []);
	if (n === null) return null;
	if (!queues) {
		queues = new Map();
		extras.set(guildId, queues);
	}
	const player = make(n);
	queues.set(n, player);
	return player;
}

/** Take a queue out of the guild's list. The caller closes it. */
export function removeQueue(player: CustomAudioPlayer) {
	const queues = extras.get(player.guildId);
	if (queues?.get(player.queueId) !== player) return false;
	queues.delete(player.queueId);
	if (!queues.size) extras.delete(player.guildId);
	return true;
}

/**
 * Drop all the guild's queues past the first. `send` tells the sidecar too;
 * left off when its session is already gone.
 */
export function dropExtraQueues(guildId: string, { send = true } = {}) {
	for (const player of extraQueues(guildId)) {
		removeQueue(player);
		player.close({ send });
	}
}
