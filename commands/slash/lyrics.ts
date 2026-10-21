import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	EmbedBuilder,
	SlashCommandBuilder,
} from "discord.js";
import type { Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";
import {
	delayLyrics,
	lineIndexAt,
	lyricsDelayMs,
	lyricsForQuery,
	lyricsForTrack,
	type LyricLine,
	type Lyrics,
} from "../../lib/lyrics";
import { getAudioPlayer, timeFormat } from "../../lib/voice/core";

/** How long the buttons keep working, inside the 15 minute interaction token */
const ACTIVE_MS = 10 * 60 * 1000;
/** How often a following message checks whether the line moved */
const FOLLOW_TICK_MS = 2500;
const LINES_BEFORE = 3;
const LINES_AFTER = 8;
// Embed descriptions cap at 4096; leave room for the markup around a page
const PAGE_CHARS = 3500;

const BUTTON = {
	previous: "lyrics:previous",
	next: "lyrics:next",
	follow: "lyrics:follow",
	full: "lyrics:full",
} as const;

function lyricText(lyrics: Lyrics) {
	return (
		lyrics.plain ??
		lyrics.synced?.map((line) => line.text).join("\n") ??
		""
	).trim();
}

/** Splits lyrics into embed-sized pages, breaking between lines. */
export function paginate(text: string, max = PAGE_CHARS): string[] {
	const pages: string[] = [];
	let page = "";
	for (const line of text.split("\n")) {
		// A single line longer than a page is cut where it must be
		for (let rest = line; ; ) {
			const piece = rest.slice(0, max);
			rest = rest.slice(max);
			if (page && page.length + 1 + piece.length > max) {
				pages.push(page);
				page = "";
			}
			page = page ? `${page}\n${piece}` : piece;
			if (!rest) break;
		}
	}
	if (page.trim()) pages.push(page);
	return pages.length ? pages : [""];
}

/** The lines around the current one, with the current one marked. */
export function syncedWindow(lines: LyricLine[], index: number): string {
	const start = Math.max(0, index - LINES_BEFORE);
	const end = Math.min(lines.length, Math.max(index, 0) + LINES_AFTER + 1);
	const shown = lines.slice(start, end).map((line, offset) => {
		const text = line.text || "♪";
		return start + offset === index ? `**▸ ${text}**` : text;
	});
	if (index < 0) shown.unshift("**▸ ♪**");
	return shown.join("\n");
}

export default {
	data: new SlashCommandBuilder()
		.setName("lyrics")
		.setDescription("Show the lyrics of the song playing, or search for some")
		.addStringOption((opt) =>
			opt
				.setName("search")
				.setDescription("Search for lyrics instead of using the song playing"),
		),
	async execute({ interaction, client, language }) {
		const query = interaction.options.getString("search")?.trim() || null;
		const player = interaction.guildId
			? getAudioPlayer(client, interaction.guildId, interaction.channel, language, {
					createPlayer: false,
				})
			: null;
		const track = player?.isPlaying ? player.nowPlaying : null;

		if (!query && !track) {
			return interaction.reply({
				content: languageText("lyrics_no_song", language),
				ephemeral: true,
			});
		}

		await interaction.deferReply();

		let lyrics: Lyrics | null;
		try {
			lyrics = query
				? await lyricsForQuery(query, track?.details.durationInSec)
				: await lyricsForTrack({
						url: track!.url,
						title: track!.details.title,
						channel: track!.channel.name,
						durationInSec: track!.details.durationInSec,
					});
		} catch {
			return interaction.editReply(languageText("lyrics_failed", language));
		}

		const lookedFor = query ?? track!.details.title;
		if (!lyrics) {
			return interaction.editReply(
				languageText("lyrics_not_found", language, { title: lookedFor }),
			);
		}
		const text = lyricText(lyrics);
		if (!text) {
			return interaction.editReply(
				languageText(
					lyrics.instrumental ? "lyrics_instrumental" : "lyrics_not_found",
					language,
					{ title: lookedFor },
				),
			);
		}

		const pages = paginate(text);
		const synced = delayLyrics(lyrics, lyricsDelayMs()).synced;
		// Following only means something for the track the bot is playing
		const canFollow = Boolean(synced && track && player && !query);
		const playCount = player?.playCounter;
		const songChanged = () => player?.playCounter !== playCount;
		const positionMs = () => player?.getCurrentSongPosition() ?? 0;

		const state = {
			following: canFollow,
			page: 0,
			lineIndex: -2,
			ended: false,
		};

		const render = (endedNote?: string) => {
			const embed = new EmbedBuilder()
				.setTitle(lyrics.trackName)
				.setAuthor({ name: lyrics.artistName })
				.setFooter({
					text: [
						endedNote,
						!state.following && pages.length > 1
							? languageText("lyrics_page", language, {
									page: state.page + 1,
									total: pages.length,
								})
							: null,
						languageText("lyrics_source", language),
					]
						.filter(Boolean)
						.join(" · "),
				});
			const thumbnail = !query ? track?.details.thumbnails.at(-1)?.url : null;
			if (thumbnail) embed.setThumbnail(thumbnail);

			if (state.following && synced) {
				const ms = positionMs();
				state.lineIndex = lineIndexAt(synced, ms);
				embed.setDescription(
					`\`${timeFormat(ms / 1000)} / ${timeFormat(track!.details.durationInSec)}\`\n\n${syncedWindow(synced, state.lineIndex)}`,
				);
			} else {
				embed.setDescription(pages[state.page] || "​");
			}

			const row = new ActionRowBuilder<ButtonBuilder>();
			if (!state.following && pages.length > 1) {
				row.addComponents(
					new ButtonBuilder()
						.setCustomId(BUTTON.previous)
						.setLabel(languageText("lyrics_previous", language))
						.setStyle(ButtonStyle.Secondary)
						.setDisabled(state.page === 0),
					new ButtonBuilder()
						.setCustomId(BUTTON.next)
						.setLabel(languageText("lyrics_next", language))
						.setStyle(ButtonStyle.Secondary)
						.setDisabled(state.page === pages.length - 1),
				);
			}
			if (canFollow && !songChanged()) {
				row.addComponents(
					state.following
						? new ButtonBuilder()
								.setCustomId(BUTTON.full)
								.setLabel(languageText("lyrics_full", language))
								.setStyle(ButtonStyle.Secondary)
						: new ButtonBuilder()
								.setCustomId(BUTTON.follow)
								.setLabel(languageText("lyrics_follow", language))
								.setStyle(ButtonStyle.Primary),
				);
			}
			return {
				content: "",
				embeds: [embed],
				components: state.ended || !row.components.length ? [] : [row],
			};
		};

		const message = await interaction.editReply(render());
		if (!message.components.length && !canFollow) return;

		// One edit at a time: a button press and a follow tick can land together
		let editing = Promise.resolve();
		const edit = (update: () => Parameters<typeof interaction.editReply>[0]) => {
			editing = editing
				.then(() => interaction.editReply(update()))
				.then(
					() => {},
					() => {},
				);
			return editing;
		};

		const collector = message.createMessageComponentCollector({
			componentType: ComponentType.Button,
			time: ACTIVE_MS,
		});

		const timer = canFollow
			? setInterval(() => {
					if (!state.following || state.ended) return;
					if (songChanged()) {
						collector.stop("song changed");
						return;
					}
					if (lineIndexAt(synced!, positionMs()) !== state.lineIndex) {
						edit(render);
					}
				}, FOLLOW_TICK_MS)
			: null;

		collector.on("collect", async (button) => {
			switch (button.customId) {
				case BUTTON.previous:
					state.page = Math.max(0, state.page - 1);
					break;
				case BUTTON.next:
					state.page = Math.min(pages.length - 1, state.page + 1);
					break;
				case BUTTON.follow:
					state.following = !songChanged();
					break;
				case BUTTON.full:
					state.following = false;
					// Open the page holding the line being sung
					if (synced && state.lineIndex >= 0) {
						const before = synced
							.slice(0, state.lineIndex)
							.map((l) => l.text)
							.join("\n").length;
						let seen = 0;
						state.page = pages.findIndex((p) => (seen += p.length + 1) > before);
						if (state.page < 0) state.page = 0;
					}
					break;
			}
			await button.deferUpdate().catch(() => {});
			edit(render);
		});

		collector.on("end", (_, reason) => {
			if (timer) clearInterval(timer);
			state.ended = true;
			const note =
				reason === "song changed"
					? languageText("lyrics_song_changed", language)
					: undefined;
			if (note) state.following = false;
			edit(() => render(note));
		});
	},
} as Command<SlashCommandBuilder>;
