import type {
	AutocompleteInteraction,
	ChatInputCommandInteraction,
	SlashCommandIntegerOption,
} from "discord.js";
import { numberedChoices } from "../autocompletePlan";
import type { CustomAudioPlayer, CustomClient } from "../custom";
import type { Language } from "../interaction";
import { languageText } from "../language";
import { guildQueues } from "./core";
import { nativeVoiceActive } from "./native";
import { MAX_QUEUES, freeQueueNumber } from "./queuePlan";

/**
 * The `queue` option the commands that act on a queue share: which of the
 * guild's queues, by number. Queue 1 is the one `/play` has always filled;
 * left out, a command means queue 1, except pause, resume, volume and stop,
 * which then mean every queue at once.
 */
export const QUEUE_OPTION = "queue";

export const queueOption =
	(description = "Which queue, by number; 1 if left empty") =>
	(opt: SlashCommandIntegerOption) =>
		opt
			.setName(QUEUE_OPTION)
			.setDescription(description)
			.setMinValue(1)
			.setMaxValue(MAX_QUEUES)
			.setAutocomplete(true);

/** The queue a command names, or null when it names none. */
export function queueOf(interaction: ChatInputCommandInteraction | AutocompleteInteraction) {
	return interaction.options.getInteger(QUEUE_OPTION);
}

/** Whether the queue option is the one being typed into. */
export function typingQueue(interaction: AutocompleteInteraction) {
	return interaction.options.getFocused(true).name === QUEUE_OPTION;
}

/** What a queue is doing, for its suggestion. */
function queueLabel(queue: CustomAudioPlayer, language: Language) {
	const title = queue.isPlaying ? queue.nowPlaying?.title : undefined;
	const queued = queue.queue.length;
	return title
		? languageText("queue_choice_playing", language, { queue: queue.queueId, title, queued })
		: languageText("queue_choice_idle", language, { queue: queue.queueId, queued });
}

/**
 * Suggest the guild's queues. `offerNew` adds the next free number, for a
 * command that starts a queue by naming one that is not there yet;
 * `mixOnly` leaves out queue 1, for `/mix`.
 */
export function respondQueues(
	interaction: AutocompleteInteraction,
	client: CustomClient,
	language: Language,
	{ offerNew = false, mixOnly = false } = {},
) {
	const queues = interaction.guildId ? guildQueues(client, interaction.guildId) : [];
	const entries = queues
		.filter((queue) => !mixOnly || queue.queueId !== 1)
		.map((queue) => ({ value: queue.queueId, label: queueLabel(queue, language) }));
	if (!mixOnly && !queues.some((queue) => queue.queueId === 1)) {
		entries.unshift({ value: 1, label: languageText("queue_choice_idle", language, { queue: 1, queued: 0 }) });
	}
	if (offerNew && nativeVoiceActive()) {
		const free = freeQueueNumber(queues.map((queue) => queue.queueId));
		if (free !== null) entries.push({ value: free, label: languageText("queue_choice_new", language, { queue: free }) });
	}
	return interaction.respond(numberedChoices(entries, String(interaction.options.getFocused())));
}

/**
 * Why a command naming queue `n` cannot have it, as a reply, or null when it
 * can: only the sidecar plays more than one.
 */
export function queueRefusal(n: number | null, language: Language) {
	if (n === null || n === 1 || nativeVoiceActive()) return null;
	return languageText("queue_native_only", language);
}
