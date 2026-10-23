import type { Turn } from "./intentModel";

/**
 * What each member has said to the bot lately, and what the model made of
 * it, so a request can lean on the ones before it: "a bit louder" after
 * "turn it down to 40", "no, the other one" after a search, or the reply to a
 * question the bot asked back.
 *
 * Per member in a guild: someone else's "skip" is not what "play it again"
 * means. Forgotten a while after it was said (`VOICE_MEMORY_MS`, a minute
 * unless set), and only the latest turns are kept, enough for a few
 * exchanges without crowding out the instructions.
 */

/** An exchange is forgotten this long after it was said, unless set. */
export const REMEMBER_FOR_MS = 60_000;
/** Turns of what was said before that the model is sent, latest last. */
export const REMEMBERED_TURNS = 12;

type Exchange = { turns: Turn[]; at: number };

export class VoiceMemory {
	private readonly exchanges = new Map<string, Exchange[]>();

	/**
	 * `forMs` as a function is asked again each time, so a change to the
	 * setting applies from the next request.
	 */
	constructor(
		private readonly forMs: number | (() => number) = REMEMBER_FOR_MS,
		private readonly maxTurns = REMEMBERED_TURNS,
	) {}

	/** Keep one exchange: their words, then what the model answered. */
	remember(key: string, turns: Turn[], now = Date.now()) {
		const kept = this.current(key, now);
		kept.push({ turns, at: now });
		this.exchanges.set(key, kept);
	}

	/**
	 * What was said in the last minute, oldest first. Cut by whole exchanges,
	 * the latest that fit, so it never starts halfway through one, such as on
	 * search results without the search; the latest is kept whatever its size.
	 */
	recall(key: string, now = Date.now()): Turn[] {
		const kept: Turn[][] = [];
		let size = 0;
		for (const { turns } of [...this.current(key, now)].reverse()) {
			if (kept.length && size + turns.length > this.maxTurns) break;
			kept.unshift(turns);
			size += turns.length;
		}
		return kept.flat();
	}

	forget(key: string) {
		this.exchanges.delete(key);
	}

	/** The exchanges still remembered, dropping the rest. */
	private current(key: string, now: number) {
		const forMs = typeof this.forMs === "function" ? this.forMs() : this.forMs;
		const kept = (this.exchanges.get(key) ?? []).filter((exchange) => now - exchange.at <= forMs);
		if (kept.length) this.exchanges.set(key, kept);
		else this.exchanges.delete(key);
		return kept;
	}
}
