import { describe, expect, test } from "bun:test";
import { Language } from "../lib/interaction";
import { languageVariants } from "../lib/language";
import {
	type Clock,
	type EditableMessage,
	ROTATE_FOR_MS,
	ROTATE_MS,
	type TranscriptStage,
	TranscriptStatus,
} from "../lib/voice/transcriptStatus";

/** A clock moved by hand, running whatever is due as it goes. */
function fakeClock() {
	let now = 0;
	let timers: { run: () => void; ms: number; next: number }[] = [];
	const clock: Clock = {
		now: () => now,
		every(run, ms) {
			const timer = { run, ms, next: now + ms };
			timers.push(timer);
			return () => {
				timers = timers.filter((other) => other !== timer);
			};
		},
	};
	const advance = (ms: number) => {
		const until = now + ms;
		for (;;) {
			const due = timers.filter((timer) => timer.next <= until).sort((a, b) => a.next - b.next)[0];
			if (!due) break;
			now = due.next;
			due.next += due.ms;
			due.run();
		}
		now = until;
	};
	return { clock, advance };
}

/** A message that records what it was edited to. */
function fakeMessage() {
	const contents: string[] = [];
	const message: EditableMessage = {
		edit: async ({ content }) => {
			contents.push(content);
		},
	};
	return { message, contents };
}

const WORDINGS: Record<TranscriptStage, string[]> = {
	listening: ["listening", "all ears", "still listening"],
	transcribing: ["transcribing", "writing it down"],
	generating: ["model generating", "thinking"],
};

/** Let queued edits run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("TranscriptStatus", () => {
	test("rotates a stage's wordings while it lasts", async () => {
		const { clock, advance } = fakeClock();
		const { message, contents } = fakeMessage();
		new TranscriptStatus(Promise.resolve(message), "listening", (stage) => WORDINGS[stage], clock);
		advance(ROTATE_MS * 3);
		await settle();
		// The first wording was posted with the message, so rotation starts
		// at the second and comes back round.
		expect(contents).toEqual(["all ears", "still listening", "listening"]);
	});

	test("a new stage shows its first wording at once, then rotates on its own time", async () => {
		const { clock, advance } = fakeClock();
		const { message, contents } = fakeMessage();
		const status = new TranscriptStatus(Promise.resolve(message), "listening", (stage) => WORDINGS[stage], clock);
		advance(ROTATE_MS - 1);
		status.set("transcribing");
		advance(ROTATE_MS - 1);
		await settle();
		expect(contents).toEqual(["transcribing"]);
		advance(1);
		status.set("transcribing");
		status.set("generating");
		await settle();
		expect(contents).toEqual(["transcribing", "writing it down", "model generating"]);
	});

	test("nothing lands after finish, even an edit queued behind a slow one", async () => {
		const { clock, advance } = fakeClock();
		const contents: string[] = [];
		let release = () => {};
		const message: EditableMessage = {
			edit: ({ content }) =>
				new Promise<void>((resolve) => {
					contents.push(content);
					release = resolve;
				}),
		};
		const status = new TranscriptStatus(Promise.resolve(message), "listening", (stage) => WORDINGS[stage], clock);
		status.set("transcribing");
		status.set("generating");
		await settle();
		// "transcribing" is in flight; "model generating" waits behind it.
		const finished = status.finish();
		release();
		expect(await finished).toBe(message);
		advance(ROTATE_MS * 4);
		await settle();
		expect(contents).toEqual(["transcribing"]);
	});

	test("stops rotating after a while, for a wake that is never answered", async () => {
		const { clock, advance } = fakeClock();
		const { message, contents } = fakeMessage();
		new TranscriptStatus(Promise.resolve(message), "listening", (stage) => WORDINGS[stage], clock);
		advance(ROTATE_FOR_MS);
		await settle();
		const edits = contents.length;
		advance(ROTATE_FOR_MS);
		await settle();
		expect(contents.length).toBe(edits);
	});

	test("a status that could not be posted edits nothing", async () => {
		const { clock, advance } = fakeClock();
		const status = new TranscriptStatus<EditableMessage>(
			Promise.resolve(null),
			"listening",
			(stage) => WORDINGS[stage],
			clock,
		);
		status.set("generating");
		advance(ROTATE_MS * 2);
		expect(await status.finish()).toBeNull();
	});
});

describe("the status wordings", () => {
	const stages = ["listening", "transcribing", "generating"];

	test("every language has several for every stage, each naming the member", () => {
		for (const language of [Language.English, Language.Japanese, Language.Korean, Language.TraditionalChinese]) {
			for (const stage of stages) {
				const wordings = languageVariants(`voice_transcript_${stage}`, language, { user: "<@1>" });
				expect(wordings.length).toBeGreaterThanOrEqual(3);
				for (const wording of wordings) expect(wording).toContain("<@1>");
			}
		}
	});

	test("the first wording of each is the plain phrase", () => {
		const first = (stage: string) => languageVariants(`voice_transcript_${stage}`, Language.English, { user: "x" })[0];
		expect(first("listening")).toContain("listening…");
		expect(first("transcribing")).toContain("transcribing…");
		expect(first("generating")).toContain("model generating…");
	});
});
