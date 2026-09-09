import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The bot's half of the deploy loop.
 *
 * A launchd agent on the host (scripts/deploy/deploy.sh) watches origin/main,
 * waits for CI to go green, builds and tests that commit in a staging clone,
 * and records the result here. Nothing it does touches the running bot: a music
 * bot that restarts itself mid-song is worse than one that is a few commits
 * behind, so applying the update is an explicit admin action.
 *
 * Applying is two steps that meet in this file. The bot sets `applyRequested`
 * and exits; scripts/deploy/run.sh — the launchd entry point, which restarts the
 * bot on every exit — sees the flag while the process is down, fast-forwards the
 * checkout, copies the staged build in, and starts the new version. The swap
 * happens with nothing running, so no module ever loads against a tree that
 * changed underneath it.
 *
 * The state file lives outside the repository (see `statePath`) because both
 * halves need it and neither should be dirtying the checkout to get at it.
 */

/** A commit the deploy agent has built and tested, waiting to be applied. */
export interface PendingRelease {
	sha: string;
	/** First line of the commit message, for showing a human what is waiting. */
	subject: string;
	/** ISO timestamp of when the staging build finished. */
	builtAt: string;
}

export interface DeployState {
	/** The commit currently running, as of the last apply. */
	applied?: { sha: string; appliedAt: string };
	/** Built, tested, and ready — the thing /restart applies. */
	pending?: PendingRelease;
	/**
	 * A commit whose staging build failed. Kept so the agent stops retrying a
	 * commit it already knows is broken, and so the failure is visible.
	 */
	failed?: { sha: string; failedAt: string; step: string };
	/** Set by the bot immediately before exiting, cleared by run.sh. */
	applyRequested?: boolean;
}

export function statePath(): string {
	return (
		process.env.AMHRA_DEPLOY_STATE ?? join(homedir(), ".amhra", "state.json")
	);
}

/**
 * Reads the deploy state, or null when there is none. A host without the deploy
 * agent installed is the normal case for a development checkout, not an error.
 */
export function readDeployState(): DeployState | null {
	const path = statePath();
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as DeployState;
	} catch {
		return null;
	}
}

function writeDeployState(state: DeployState): void {
	const path = statePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** What is waiting to be applied, if anything. */
export function pendingRelease(): PendingRelease | null {
	return readDeployState()?.pending ?? null;
}

/**
 * Flags the staged release to be applied on the next start. Returns what will
 * be applied, or null when there is nothing staged — the caller should say so
 * rather than restart into the same commit for no reason.
 */
export function requestApply(): PendingRelease | null {
	const state = readDeployState();
	if (!state?.pending) return null;
	writeDeployState({ ...state, applyRequested: true });
	return state.pending;
}

/**
 * Flags a plain restart with no version change — for getting out of a wedged
 * state. Recorded the same way so run.sh logs it alongside real applies.
 */
export function requestRestart(): void {
	writeDeployState({ ...(readDeployState() ?? {}), applyRequested: false });
}
