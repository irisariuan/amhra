import {
	ActionRowBuilder,
	ComponentType,
	StringSelectMenuBuilder,
	type ChatInputCommandInteraction,
	type CacheType,
} from "discord.js";
import type { CustomAudioPlayer } from "../custom";
import type { Language } from "../interaction";
import { languageText } from "../language";
import { dcb, globalApp } from "../misc";
import { createResource, timeFormat } from "./core";
import { replaceLayerFromInput } from "./mix";
import type { MixLayer } from "./mixPlan";
import type { YouTubeVideo } from "../youtube";

/** Alternatives offered besides the one already queued */
const MAX_CHOICES = 5;
/** How long the picker stays usable */
const PICKER_TIMEOUT_MS = 60_000;
/** How long a resolved picker stays on screen before being removed */
const DISMISS_DELAY_MS = 8_000;

const SELECT_ID = "search-pick";

/** Discord rejects select option labels over 100 characters */
function trim(text: string, max: number) {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Offer the other search hits after the best one has already been used.
 *
 * Searching plays something immediately rather than making everyone wait on a
 * menu, so this is the escape hatch for when the top hit was the wrong song:
 * picking here hands the old and new URL to `swap`, which puts the new one in
 * the old one's place — the queue's track for /play, a mix layer for /mix.
 * `swap` resolves false when the old one is gone, and throws when the switch
 * failed. Ephemeral, so only the person who ran the command sees or can use it.
 */
async function sendSearchAlternatives({
	interaction,
	language,
	results,
	chosenUrl,
	swap,
}: {
	interaction: ChatInputCommandInteraction<CacheType>;
	language: Language;
	results: YouTubeVideo[];
	chosenUrl: string;
	swap: (currentUrl: string, nextUrl: string) => Promise<boolean>;
}) {
	const choices = results.slice(0, MAX_CHOICES);
	// Nothing to switch between
	if (choices.length < 2) return;

	/** The menu with `selectedUrl` shown as the current pick. */
	const optionsFor = (selectedUrl: string) =>
		choices.map((video, index) => ({
			label: trim(video.title, 100),
			description: trim(
				`${video.channel.name} · ${timeFormat(video.durationInSec)}`,
				100,
			),
			value: String(index),
			default: video.url === selectedUrl,
		}));

	const menu = new StringSelectMenuBuilder()
		.setCustomId(SELECT_ID)
		.setPlaceholder(languageText("search_pick_placeholder", language))
		.addOptions(optionsFor(chosenUrl));

	const message = await interaction
		.followUp({
			content: languageText("search_pick", language),
			components: [
				new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
			],
			ephemeral: true,
		})
		.catch(() => null);
	if (!message) return;

	/** Removes the picker; ephemeral messages can only be dropped via the interaction */
	const dismiss = (delay: number) =>
		setTimeout(() => {
			interaction.deleteReply(message.id).catch(() => {});
		}, delay).unref?.();

	// Follows the swaps, so switching twice replaces the second pick, not the first
	let currentUrl = chosenUrl;

	const collector = message.createMessageComponentCollector({
		componentType: ComponentType.StringSelect,
		time: PICKER_TIMEOUT_MS,
		// Ephemeral already hides this from everyone else; this stops the
		// message being driven by anyone who somehow reaches it
		filter: (component) => component.user.id === interaction.user.id,
	});

	collector.on("collect", async (component) => {
		const picked = choices[Number(component.values[0])];
		if (!picked || picked.url === currentUrl) {
			await component.deferUpdate().catch(() => {});
			return;
		}

		// Acknowledge before doing any of the work.
		//
		// Swapping a track builds a resource, which can mean waiting on a
		// download to start, and Discord discards a component interaction that
		// has not been answered within three seconds. Replying afterwards then
		// fails, and since the failure was swallowed the switch happened with
		// nothing at all shown for it.
		const acknowledged = await component.deferUpdate().then(
			() => true,
			(error: Error) => {
				globalApp.err("Search pick could not acknowledge the choice", error);
				return false;
			},
		);
		if (!acknowledged) return;

		try {
			const swapped = await swap(currentUrl, picked.url);
			if (!swapped) {
				await component.editReply({
					content: languageText("search_pick_gone", language),
					components: [],
				});
				collector.stop("gone");
				return;
			}

			currentUrl = picked.url;
			dcb.log(`Search pick switched to ${picked.url}`);
			await component.editReply({
				content: languageText("search_pick_switched", language, {
					title: picked.title,
					url: picked.url,
				}),
				flags: ["SuppressEmbeds"],
				// Keep the menu so a second guess is one click away
				components: [
					new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
						StringSelectMenuBuilder.from(menu).setOptions(
							optionsFor(currentUrl),
						),
					),
				],
			});
		} catch (error) {
			// Reported rather than dropped: a silent catch here is what made a
			// missing confirmation impossible to tell apart from a switch that
			// never happened.
			globalApp.err("Search pick failed to switch track", error as Error);
			await component
				.editReply({
					content: languageText("error", language),
					components: [],
				})
				.catch(() => {});
		}
	});

	collector.on("end", (_collected, reason) => {
		dismiss(reason === "gone" ? DISMISS_DELAY_MS : 0);
	});
}

interface Alternatives {
	interaction: ChatInputCommandInteraction<CacheType>;
	results: YouTubeVideo[];
	chosenUrl: string;
}

/** For /play: a pick replaces the queued song, playing or not. */
export function offerQueueAlternatives({
	player,
	...alternatives
}: Alternatives & { player: CustomAudioPlayer }) {
	return sendSearchAlternatives({
		...alternatives,
		language: player.currentLanguage,
		swap: (currentUrl, nextUrl) => swapTrack(player, currentUrl, nextUrl),
	});
}

/** For /mix add: a pick replaces the mixed-in song, at its volume and place. */
export function offerLayerAlternatives({
	guildId,
	layer,
	language,
	...alternatives
}: Alternatives & { guildId: string; layer: MixLayer; language: Language }) {
	// Follows the replacements, since each one is a new layer
	let current = layer;
	return sendSearchAlternatives({
		...alternatives,
		language,
		swap: async (_currentUrl, nextUrl) => {
			const replaced = await replaceLayerFromInput(guildId, current, nextUrl);
			if ("error" in replaced) {
				if (replaced.error === "gone") return false;
				throw new Error(`Could not replace mix layer: ${replaced.error}`);
			}
			current = replaced.layer;
			return true;
		},
	});
}

/**
 * Point the queue at `nextUrl` wherever `currentUrl` currently sits.
 *
 * Returns false when the track is neither playing nor queued any more, which
 * happens if it finished or was skipped while the picker was open.
 */
async function swapTrack(
	player: CustomAudioPlayer,
	currentUrl: string,
	nextUrl: string,
) {
	if (player.nowPlaying?.url === currentUrl) {
		// A failure to build the resource is not the same as the track being
		// gone, so it is left to throw: the caller says "something went wrong"
		// rather than the misleading "that track is no longer here".
		const resource = await createResource(nextUrl);
		if (!resource) return false;
		player.playResource(resource);
		return true;
	}

	const index = player.queue.findIndex((item) => item.url === currentUrl);
	if (index < 0) return false;
	player.queue[index] = { ...player.queue[index], url: nextUrl };
	return true;
}
