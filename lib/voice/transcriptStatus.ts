/**
 * The status line shown, for someone who asked to see what was heard, between
 * the wake and the answer: listening, then transcribing, then the model
 * generating. Each stage has a few wordings, taken in turn every
 * `ROTATE_MS` while it lasts, so a long wait visibly is one.
 *
 * Kept apart from voiceCommands.ts, and from discord.js, so the timing can be
 * tested with a fake clock and a fake message.
 */

export type TranscriptStage = "listening" | "transcribing" | "generating";

/** How long one wording stays up. Discord allows five edits per five seconds. */
export const ROTATE_MS = 2500;
/**
 * Stop rotating after this long, whatever the stage. A command the sidecar
 * dropped never ends in an answer, and the line should not change forever.
 */
export const ROTATE_FOR_MS = 60_000;

/** As much of a discord.js `Message` as this needs. */
export interface EditableMessage {
	edit(options: { content: string; allowedMentions: { parse: [] } }): Promise<unknown>;
}

export interface Clock {
	now(): number;
	/** Call `run` every `ms`; the returned function stops it. */
	every(run: () => void, ms: number): () => void;
}

const realClock: Clock = {
	now: () => Date.now(),
	every(run, ms) {
		const timer = setInterval(run, ms);
		timer.unref?.();
		return () => clearInterval(timer);
	},
};

export class TranscriptStatus<M extends EditableMessage> {
	private stage: TranscriptStage;
	private variant = 0;
	private readonly started: number;
	private stopTimer: (() => void) | null = null;
	/** Edits run one after another, so they land in the order they were made. */
	private edits: Promise<void> = Promise.resolve();
	private finished = false;
	/** What they have said so far, shown under the wording. */
	private said: string | null = null;
	/** An edit showing them is waiting its turn, and will show the latest. */
	private heardQueued = false;

	/**
	 * `message` is the status already posted, at its first wording of
	 * `stage`, or null if it could not be; it may still be on its way.
	 * `wordings` gives a stage's wordings, at least one.
	 */
	constructor(
		readonly message: Promise<M | null>,
		stage: TranscriptStage,
		private readonly wordings: (stage: TranscriptStage) => string[],
		private readonly clock: Clock = realClock,
	) {
		this.stage = stage;
		this.started = clock.now();
		this.rotate();
	}

	/** Move on to a stage, showing its first wording at once. */
	set(stage: TranscriptStage) {
		if (this.finished || stage === this.stage) return;
		this.stage = stage;
		this.variant = 0;
		this.show();
		// Each stage gets its first wording for a whole turn.
		this.rotate();
	}

	/**
	 * Show `line`, what they have said so far, under the wording, in place of the
	 * last. Each resets the rotation, so words coming in are all that changes.
	 */
	heard(line: string) {
		if (this.finished) return;
		this.said = line;
		// Behind a slow edit only the latest counts: a queue of them would only
		// get further behind what is being said.
		if (!this.heardQueued) {
			this.heardQueued = true;
			this.queue(() => {
				this.heardQueued = false;
				return this.current();
			});
		}
		this.rotate();
	}

	/**
	 * Stop changing the line, wait for any edit already made, and hand over
	 * the message for the answer to replace. No edit of this lands after it.
	 */
	async finish(): Promise<M | null> {
		this.finished = true;
		this.stopTimer?.();
		this.stopTimer = null;
		await this.edits;
		return this.message;
	}

	private rotate() {
		this.stopTimer?.();
		this.stopTimer = this.clock.every(() => {
			if (this.clock.now() - this.started >= ROTATE_FOR_MS) {
				this.stopTimer?.();
				this.stopTimer = null;
				return;
			}
			this.variant += 1;
			this.show();
		}, ROTATE_MS);
	}

	private show() {
		const content = this.current();
		if (content !== undefined) this.queue(() => content);
	}

	/** The line as it stands: the wording, and what they have said under it. */
	private current() {
		const wordings = this.wordings(this.stage);
		const wording = wordings[this.variant % wordings.length];
		return wording !== undefined && this.said ? `${wording}\n${this.said}` : wording;
	}

	private queue(content: () => string | undefined) {
		this.edits = this.edits.then(async () => {
			const latest = content();
			// Checked when the edit's turn comes, not when it was made: one
			// queued behind a slow edit must not land after the answer.
			if (this.finished || latest === undefined) return;
			const message = await this.message;
			await message?.edit({ content: latest, allowedMentions: { parse: [] } }).catch(() => {});
		});
	}
}
