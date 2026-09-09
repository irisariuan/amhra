/**
 * The rules for a guild's fade lengths.
 *
 * Apart from the player that holds them, because that class reaches
 * @distube/ytdl-core through its imports and cannot load under Bun, and
 * because both rules below have a way of being quietly wrong: a partial
 * adjustment that resets the half nobody touched, and a settings save that
 * undoes every live adjustment.
 */

/** How long a seam is mixed over, and the shorter fade used for a skip. */
export interface Fades {
	crossfadeMs: number;
	skipFadeMs: number;
}

/** No crossfade, and a short skip fade so a skip feels immediate, not mixed. */
export const DEFAULT_FADES: Fades = { crossfadeMs: 0, skipFadeMs: 40 };

/** Milliseconds, non-negative and whole. Anything else is a caller's mistake. */
function clamp(value: number, fallback: number) {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(0, Math.round(value));
}

/**
 * Apply an adjustment to a guild's fades.
 *
 * A change carrying only one half leaves the other alone: the dashboard's two
 * sliders move independently, and a control that reset its neighbour to zero
 * every time it moved would be worse than no control.
 */
export function nextFades(current: Fades, change: Partial<Fades>): Fades {
	return {
		crossfadeMs:
			change.crossfadeMs === undefined
				? current.crossfadeMs
				: clamp(change.crossfadeMs, current.crossfadeMs),
		skipFadeMs:
			change.skipFadeMs === undefined
				? current.skipFadeMs
				: clamp(change.skipFadeMs, current.skipFadeMs),
	};
}

/**
 * What a guild's fades should become after the global default changes, or
 * `null` when they should be left exactly as they are.
 *
 * A guild nobody has adjusted follows the new default. One that has been
 * adjusted keeps its own values, the same way a guild's volume survives an
 * edit to VOLUME_MODIFIER — otherwise saving an unrelated setting would
 * silently undo whatever was set from the player controls.
 *
 * Null rather than the unchanged pair, because the caller's next move is to
 * push the values across a process boundary: "nothing changed" and "changed to
 * the same numbers" are the same fades but not the same amount of work.
 */
export function syncedFades(
	current: Fades,
	overridden: boolean,
	fromSetting: Fades,
): Fades | null {
	if (overridden) return null;
	if (
		fromSetting.crossfadeMs === current.crossfadeMs &&
		fromSetting.skipFadeMs === current.skipFadeMs
	) {
		return null;
	}
	return fromSetting;
}

/** Read a pair of fades from loosely-typed settings, with the defaults. */
export function fadesFrom(source: {
	CROSSFADE_IN_MS?: number;
	SKIP_FADE_IN_MS?: number;
}): Fades {
	return {
		crossfadeMs: clamp(
			source.CROSSFADE_IN_MS ?? DEFAULT_FADES.crossfadeMs,
			DEFAULT_FADES.crossfadeMs,
		),
		skipFadeMs: clamp(
			source.SKIP_FADE_IN_MS ?? DEFAULT_FADES.skipFadeMs,
			DEFAULT_FADES.skipFadeMs,
		),
	};
}
