import { randomUUID } from "node:crypto";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	type Message,
	type VoiceState,
} from "discord.js";
import type { CustomClient } from "../custom";
import { Language } from "../interaction";
import { languageText } from "../language";
import { dcb, globalApp } from "../misc";
import { getUpcoming, type Upcoming } from "../premiere";
import { event } from "../server/event";
import { getYouTubeVideoId } from "../youtube";
import {
	createResource,
	getAudioPlayer,
	getConnection,
	getVideoInfo,
} from "./core";
import { sendSkipMessage } from "./segment";
import { fireTime, planTimer } from "./schedulePlan";

/**
 * Videos set to cut in at a given time, per guild.
 *
 * Ten seconds before the time, the channel is asked whether to let it happen —
 * "don't cut in" drops it, "play next instead" queues it behind the current
 * song. Left alone, it interrupts whatever is playing, and the interrupted
 * track resumes from where it was once the scheduled one ends.
 *
 * A schedule belongs to the bot's seat in voice. The leave sweep holds the bot
 * in its channel while anything is pending, and the bot leaving — for whatever
 * reason — clears the guild's schedules. That is also why nothing here is
 * persisted: a restart drops the bot out of voice, which would clear them.
 */

export interface ScheduledPlay {
	id: string;
	guildId: string;
	url: string;
	title: string;
	/** When it was asked to cut in, epoch milliseconds */
	at: number;
	/** When the ten-second warning went out, or null before then */
	warnedAt: number | null;
	/** An upcoming premiere, whose start is retried until it goes live */
	premiere: boolean;
	/** Text channel the warning goes to */
	channelId: string | null;
	/** Who asked, for the log */
	createdBy: string;
	language: Language;
}

/** What the dashboard is told about one. */
export interface PublicScheduledPlay {
	id: string;
	url: string;
	title: string;
	at: number;
	/** When it will actually cut in: later than `at` if the warning was late */
	fireAt: number;
	/** The warning is out and the channel can still stop it */
	warning: boolean;
	/** It is being started, which a premiere may retry for a while */
	starting: boolean;
	premiere: boolean;
	createdBy: string;
}

interface Armed {
	entry: ScheduledPlay;
	timer: NodeJS.Timeout | null;
	/** The warning, edited to say how things ended */
	message: Message | null;
	starting: boolean;
}

/**
 * A premiere's stream is not always up the second it is due. Each attempt is
 * one failed `createResource`; this many, this far apart, covers the delays
 * YouTube actually has without holding the bot in voice forever.
 */
const PREMIERE_RETRY_MS = 15_000;
const PREMIERE_ATTEMPTS = 20;

const CANCEL_ID = "schedule-cancel";
const QUEUE_ID = "schedule-queue";

const schedules = new Map<string, Armed>();
let boundClient: CustomClient | null = null;

export type ScheduleOutcome = "cancelled" | "queued";

/**
 * Wire schedules to the client: where to find players, and the voice state
 * that clears them. Call once at boot.
 */
export function bindSchedules(client: CustomClient) {
	if (boundClient === client) return;
	boundClient = client;
	client.on("voiceStateUpdate", (oldState: VoiceState, newState: VoiceState) => {
		if (newState.id !== client.user?.id) return;
		// Moving between channels keeps the schedules; only leaving clears them
		if (oldState.channelId && !newState.channelId) {
			clearSchedules(newState.guild.id);
		}
	});
}

export function hasSchedule(guildId: string): boolean {
	for (const { entry } of schedules.values()) {
		if (entry.guildId === guildId) return true;
	}
	return false;
}

function armedFor(guildId: string): Armed[] {
	return Array.from(schedules.values())
		.filter(({ entry }) => entry.guildId === guildId)
		.sort((a, b) => a.entry.at - b.entry.at);
}

export function listSchedules(guildId: string): ScheduledPlay[] {
	return armedFor(guildId).map(({ entry }) => entry);
}

export function publicSchedules(guildId: string): PublicScheduledPlay[] {
	return armedFor(guildId).map(({ entry, starting }) => ({
		id: entry.id,
		url: entry.url,
		title: entry.title,
		at: entry.at,
		fireAt: fireTime(entry.at, entry.warnedAt),
		warning: entry.warnedAt !== null && !starting,
		starting,
		premiere: entry.premiere,
		createdBy: entry.createdBy,
	}));
}

export function addSchedule(
	entry: Omit<ScheduledPlay, "id" | "warnedAt">,
): ScheduledPlay {
	const full: ScheduledPlay = { ...entry, id: randomUUID(), warnedAt: null };
	const armed: Armed = { entry: full, timer: null, message: null, starting: false };
	schedules.set(full.id, armed);
	arm(armed);
	dcb.log(
		`Scheduled ${full.url} in ${full.guildId} for ${new Date(full.at).toISOString()} (${full.createdBy})`,
	);
	return full;
}

/** Take an entry out, stopping its timer. A start already under way sees it gone and stops. */
function remove(id: string): Armed | null {
	const armed = schedules.get(id);
	if (!armed) return null;
	if (armed.timer) clearTimeout(armed.timer);
	armed.timer = null;
	schedules.delete(id);
	return armed;
}

/** Settle the warning message, if one went out, with how things ended. */
async function settle(armed: Armed, content: string) {
	const message = armed.message;
	armed.message = null;
	await message?.edit({ content, components: [] }).catch(() => {});
}

function text(
	entry: ScheduledPlay,
	id: string,
	replace: Record<string, string | number> = {},
) {
	return languageText(id, entry.language, { title: entry.title, ...replace });
}

/**
 * Answer a pending schedule: drop it, or queue it next instead of cutting in.
 *
 * Works before and during the warning. Once the cut-in has started it is too
 * late to "prevent" it, and the call reports the entry as not found.
 */
export async function respondToSchedule(
	guildId: string,
	id: string,
	outcome: ScheduleOutcome,
	by: string,
): Promise<boolean> {
	const current = schedules.get(id);
	if (!current || current.entry.guildId !== guildId || current.starting) {
		return false;
	}
	const armed = remove(id);
	if (!armed) return false;
	if (outcome === "queued") await queueInstead(armed.entry);
	dcb.log(`Schedule for ${armed.entry.url} ${outcome} (${by})`);
	await settle(
		armed,
		text(armed.entry, outcome === "queued" ? "schedule_queued" : "schedule_cancelled", { by }),
	);
	return true;
}

/** Drop every schedule in a guild — the bot left voice, so none can play. */
export function clearSchedules(guildId: string) {
	for (const armed of armedFor(guildId)) {
		remove(armed.entry.id);
		dcb.log(`Cleared schedule for ${armed.entry.url}: left voice in ${guildId}`);
		void settle(armed, text(armed.entry, "schedule_cleared_left"));
	}
}

function arm(armed: Armed) {
	const plan = planTimer(armed.entry.at, armed.entry.warnedAt, Date.now());
	armed.timer = setTimeout(() => {
		armed.timer = null;
		if (schedules.get(armed.entry.id) !== armed) return;
		switch (plan.action) {
			case "wait":
				return arm(armed);
			case "warn":
				return void warn(armed);
			case "fire":
				return void fire(armed);
		}
	}, plan.delayMs);
	// A far-off premiere must not hold the process open on its own
	armed.timer.unref?.();
}

async function warn(armed: Armed) {
	const { entry } = armed;
	entry.warnedAt = Date.now();
	// Armed before the send: a slow Discord must not push the cut-in back
	arm(armed);

	const client = boundClient;
	const player = client?.player.get(entry.guildId);
	const cutting = !!player?.isPlaying;
	const channel =
		(entry.channelId ? await client?.channels.fetch(entry.channelId).catch(() => null) : null) ??
		player?.channel ??
		null;
	if (!channel?.isSendable()) return;

	const fireAt = fireTime(entry.at, entry.warnedAt);
	const buttons = [
		new ButtonBuilder()
			.setCustomId(CANCEL_ID)
			.setStyle(ButtonStyle.Danger)
			.setLabel(text(entry, cutting ? "schedule_prevent_label" : "schedule_cancel_label")),
	];
	// With nothing playing there is nothing to cut into, so nothing to queue behind
	if (cutting) {
		buttons.push(
			new ButtonBuilder()
				.setCustomId(QUEUE_ID)
				.setStyle(ButtonStyle.Secondary)
				.setLabel(text(entry, "schedule_queue_label")),
		);
	}
	const message = await channel
		.send({
			content: text(entry, cutting ? "schedule_warning_cut" : "schedule_warning_start", {
				relative: `<t:${Math.ceil(fireAt / 1000)}:R>`,
			}),
			components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)],
		})
		.catch((error) => {
			globalApp.warn(`Failed to send schedule warning: ${error}`);
			return null;
		});
	if (!message) return;
	// Answered from the dashboard while the send was in flight
	if (schedules.get(entry.id) !== armed) {
		await message.delete().catch(() => {});
		return;
	}
	armed.message = message;

	try {
		const press = await message.awaitMessageComponent({
			componentType: ComponentType.Button,
			time: Math.max(0, fireAt - Date.now()),
		});
		// Pressed as the cut-in began: too late to stop, and fire() settles it
		if (schedules.get(entry.id) !== armed || armed.starting) {
			await press.deferUpdate().catch(() => {});
			return;
		}
		// Answered through the press rather than settle(), so the button
		// acknowledges instead of spinning until Discord gives up on it
		armed.message = null;
		const outcome: ScheduleOutcome = press.customId === QUEUE_ID ? "queued" : "cancelled";
		const by = press.user.displayName;
		await respondToSchedule(entry.guildId, entry.id, outcome, by);
		await press
			.update({
				content: text(entry, outcome === "queued" ? "schedule_queued" : "schedule_cancelled", { by }),
				components: [],
			})
			.catch(() => {});
	} catch {
		// Timed out: the cut-in goes ahead and fire() settles the message
	}
}

/** "Play next instead": behind the current song, or straight away if nothing is playing. */
async function queueInstead(entry: ScheduledPlay) {
	const client = boundClient;
	const player = client?.player.get(entry.guildId);
	if (!client || !player) return;
	if (player.isPlaying) {
		player.addToQueue(entry.url, false, 0);
		return;
	}
	const resource = await createResource(entry.url).catch(() => null);
	if (resource) player.playResource(resource);
}

async function fire(armed: Armed) {
	const { entry } = armed;
	const client = boundClient;
	const connection = getConnection(entry.guildId);
	if (!client || !connection) {
		remove(entry.id);
		await settle(armed, text(entry, "schedule_failed"));
		return;
	}
	armed.starting = true;

	let resource = null;
	const attempts = entry.premiere ? PREMIERE_ATTEMPTS : 1;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		resource = await createResource(entry.url).catch((error) => {
			globalApp.warn(`Scheduled play of ${entry.url} not ready (attempt ${attempt}): ${error}`);
			return null;
		});
		// Answered or cleared while the attempt was out
		if (schedules.get(entry.id) !== armed) return;
		if (resource || attempt === attempts) break;
		await new Promise((resolve) => setTimeout(resolve, PREMIERE_RETRY_MS));
		if (schedules.get(entry.id) !== armed) return;
	}
	remove(entry.id);
	if (!resource) {
		globalApp.err(`Scheduled play of ${entry.url} failed`);
		await settle(armed, text(entry, "schedule_failed"));
		return;
	}

	// An existing player keeps its language; getAudioPlayer would switch it
	const player =
		client.player.get(entry.guildId) ??
		getAudioPlayer(client, entry.guildId, null, entry.language);
	if (!player) return;
	connection.subscribe(player);
	const resumed = player.interruptWith(resource);
	event.emit("songInfo", entry.url);
	dcb.log(`Scheduled play of ${entry.url} cut in${resumed ? ", previous track will resume" : ""}`);
	await settle(armed, text(entry, resumed ? "schedule_playing_resume" : "schedule_playing"));
	if (resource.segments && player.customSetting.autoSkipSegment) {
		await player.skipCurrentSegment();
		await sendSkipMessage(player);
	}
}

export type ScheduleRequestError = "not_found" | "need_time" | "past";

/**
 * The premiere a link points at, or null if it plays like any other video.
 *
 * ytdl-core is asked first: it answers every ordinary video, and its answer is
 * cached for the `createResource` that follows, so the common case costs
 * nothing extra. Only a video it refuses is looked up as a premiere.
 */
export async function findUpcoming(url: string): Promise<Upcoming | null> {
	const id = getYouTubeVideoId(url);
	if (!id) return null;
	try {
		await getVideoInfo(url);
		return null;
	} catch {
		const upcoming = await getUpcoming(id).catch(() => null);
		return upcoming && upcoming.startsAt > Date.now() ? upcoming : null;
	}
}

/**
 * Schedule a video from a user's request: the shared half of `/schedule`, the
 * dashboard and `/play`'s premiere handling.
 *
 * With no time, only an upcoming premiere can be scheduled, at its start.
 */
export async function requestSchedule(request: {
	guildId: string;
	url: string;
	at: number | null;
	channelId: string | null;
	createdBy: string;
	language: Language;
	/** Already looked up by the caller, to save asking twice */
	upcoming?: Upcoming | null;
}): Promise<{ entry: ScheduledPlay } | { error: ScheduleRequestError }> {
	const upcoming =
		request.upcoming !== undefined ? request.upcoming : await findUpcoming(request.url);
	let title = upcoming?.title;
	if (!upcoming) {
		const info = await getVideoInfo(request.url).catch(() => null);
		if (!info) return { error: "not_found" };
		title = info.video_details.title;
	}
	const at = request.at ?? upcoming?.startsAt ?? null;
	if (at === null) return { error: "need_time" };
	if (at <= Date.now()) return { error: "past" };
	return {
		entry: addSchedule({
			guildId: request.guildId,
			url: upcoming?.url ?? request.url,
			title: title ?? request.url,
			at,
			premiere: !!upcoming,
			channelId: request.channelId,
			createdBy: request.createdBy,
			language: request.language,
		}),
	};
}

/** Discord's own timestamp markup, which every reader sees in their timezone. */
export function discordTime(at: number) {
	const seconds = Math.floor(at / 1000);
	return { time: `<t:${seconds}:F>`, relative: `<t:${seconds}:R>` };
}
