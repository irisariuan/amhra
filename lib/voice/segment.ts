import z from "zod";
import { CustomAudioPlayer } from "../custom";
import { dcb, globalApp, misc } from "../misc";
import { timeFormat } from "./core";
import { Language } from "../interaction";
import { languageText } from "../language";

export enum SegmentCategory {
	Sponsor = "sponsor",
	SelfPromotion = "selfpromo",
	Interaction = "interaction",
	Intro = "intro",
	Outro = "outro",
	Preview = "preview",
	MusicOffTopic = "music_offtopic",
	Filler = "filler",
}
export const segmentSchema = z.object({
	category: z.enum(SegmentCategory),
	segment: z.number().min(0).array().length(2),
	videoDuration: z.number().min(0),
	UUID: z.string(),
	locked: z.int(),
	votes: z.int(),
	description: z.string(),
});

interface CachedSegment {
	segment: Segment[];
	category: SegmentCategory[];
	fetchedTimestamp: number;
}

const cache = new Map<string, CachedSegment>();
export const segmentsSchema = z.array(segmentSchema);
/**
 * @description All numbers in seconds
 */
export type Segment = { segment: [number, number] } & z.infer<
	typeof segmentSchema
>;

export async function getSegments(
	id: string,
	categories: SegmentCategory[] = Object.values(SegmentCategory),
	useCache = true,
	ttl = 24 * 60 * 60 * 1000, // 1 day
): Promise<Segment[] | null> {
	const cached = cache.get(id);
	if (
		cached &&
		useCache &&
		cached.category === categories &&
		Date.now() - cached.fetchedTimestamp <= ttl
	) {
		return cached.segment;
	}
	const url = new URL("https://sponsor.ajay.app/api/skipSegments");
	url.searchParams.set("videoID", id);
	url.searchParams.set(
		"categories",
		`[${categories.map((v) => `"${v}"`).join(",")}]`,
	);
	const res = await fetch(url);
	if (!res.ok) return null;
	const result = await segmentsSchema
		.parseAsync(await res.json().catch(() => null))
		.catch(() => null);
	if (!result) {
		globalApp.err(`Failed to parse segments for ${id}`);
		return null;
	}
	const segments = result.filter(
		(v): v is Segment =>
			v.segment[0] !== undefined && v.segment[1] !== undefined,
	);
	if (useCache) {
		cache.set(id, {
			segment: segments,
			category: categories,
			fetchedTimestamp: Date.now(),
		});
	}
	return segments;
}

export async function deleteSkipMessage(player: CustomAudioPlayer) {
	if (!player.activeSkipMessage) return false;
	if (await player.activeSkipMessage.delete().catch(() => null)) {
		player.activeSkipMessage = null;
		return true;
	}
	return false;
}

/**
 * @param [cancelThreshold=2] - The threshold in seconds to cancel the skip message if the segment is too short
 *
 * Set to <=0 to disable this feature
 * @param [force=true] - Whether to force send the skip message even if there is already one
 *
 * Default is true, which means it will delete the previous skip message if it exists
 *
 * @description Sends a skip message to the channel if the current segment is not music
 * and waits for a reaction to skip to the next segment or to the end of the song
 * @returns Whether the skip message was sent or not
 */
export async function sendSkipMessage(
	player: CustomAudioPlayer,
	force = true,
	cancelThreshold = 2,
) {
	if (
		!player.isPlaying ||
		!player.nowPlaying?.segments ||
		player.nowPlaying.segments.length <= 0 ||
		!player.channel?.isSendable()
	) {
		globalApp.warn(
			`isPlaying: ${player.isPlaying}, segments: ${player.nowPlaying?.segments?.length ?? "UNDEFINED"}, channel: ${player.channel?.isSendable()}`,
		);
		return false;
	}

	if (player.activeSkipMessage) {
		if (force) {
			if (!(await deleteSkipMessage(player))) {
				globalApp.err("Failed to delete previous skip message");
			}
		} else {
			return false;
		}
	}

	const count = player.playCounter;
	const segment = player.currentSegment();
	if (!segment) return false;
	if (
		cancelThreshold > 0 &&
		Math.abs(segment.segment[1] - segment.segment[0]) <= cancelThreshold
	) {
		dcb.log("Skipping message cancelled due to short segment");
		return false;
	}
	const skipTo = segment.segment[1];
	const isSkippingSong =
		Math.abs(skipTo - player.nowPlaying.details.durationInSec) <= 1;
	const response = await player.channel.send({
		content: isSkippingSong
			? languageText("segment_skip_message_next", player.currentLanguage)
			: languageText("segment_skip_message", player.currentLanguage, {
					pos: timeFormat(skipTo),
					posNum: Math.round(skipTo),
				}),
	});
	dcb.log("Sent skip message, waiting for reaction");
	player.activeSkipMessage = response;
	await response.react("✅");
	try {
		await response.awaitReactions({
			filter: (reaction) =>
				reaction.emoji.name === "✅" &&
				reaction.users.cache.filter((u) => !u.bot).size > 0,
			time: Math.min(10 * 1000, skipTo * 1000),
			max: 1,
			errors: ["time"],
		});
		if (response.id !== player.activeSkipMessage?.id) {
			if (response.deletable) {
				await response.delete().catch(() => {});
			}
			return false;
		}
		player.activeSkipMessage = null;
		dcb.log("Skipping non-music part");
		for (const reaction of response.reactions.cache.values()) {
			if (reaction.emoji.name === "✅") {
				// no await to speed up
				reaction.remove();
			}
		}
		if (!player.currentSegment()) {
			await response.edit({
				content: languageText(
					"skip_cancel_no_non_music",
					player.currentLanguage,
				),
				components: [],
			});
			return true;
		}
		if (player.playCounter !== count) {
			response.edit({
				content: languageText(
					"skip_cancel_song_changed",
					player.currentLanguage,
				),
				components: [],
			});
			return true;
		}
		if (isSkippingSong) {
			player.stop();
			await response.edit({
				content: languageText(
					"segment_skip_next",
					player.currentLanguage,
				),
			});
			return true;
		}
		const result = await player.skipCurrentSegment();
		if (!result.success) {
			await response.edit(misc.errorMessageObj(player.currentLanguage));
			return true;
		}
		await response.edit({
			content: languageText(
				result.skipped ? "segment_skip_next" : "segment_skip",
				player.currentLanguage,
				{
					pos: timeFormat(skipTo),
				},
			),
			components: [],
		});
		return true;
	} catch {
		if (response.id !== player.activeSkipMessage?.id) return false;
		player.activeSkipMessage = null;
		if (response.deletable) {
			await response.delete().catch(() => {});
			return true;
		}
		if (response.editable) {
			await response.reactions.removeAll().catch(() => {});
			await response
				.edit({
					content: languageText(
						"skip_cancel_timeout",
						player.currentLanguage,
					),
					components: [],
				})
				.catch(() => {});
		}
		dcb.log("Skipping non-music part timed out");
		return true;
	}
}
