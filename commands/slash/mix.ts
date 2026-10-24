import { SlashCommandBuilder, type SlashCommandIntegerOption } from "discord.js";
import { type Command, type Language } from "../../lib/interaction";
import { languageText } from "../../lib/language";
import { dcb, misc } from "../../lib/misc";
import { searchYouTube, type YouTubeVideo } from "../../lib/youtube";
import {
	ensureVoiceConnection,
	getAudioPlayer,
	getBotVoiceChannel,
	getConnection,
	isPlaylist,
	isVideo,
	timeFormat,
} from "../../lib/voice/core";
import { indexChoices } from "../../lib/autocompletePlan";
import { findMix, getMix, nativeSetMainVolume, nativeVoiceActive } from "../../lib/voice/native";
import {
	queueOnTrack,
	removeTrack,
	setTrackVolume,
	skipTrack,
} from "../../lib/voice/mix";
import { MAX_GAP_MS, type GuildMix, type MixTrack } from "../../lib/voice/mixPlan";
import { offerTrackAlternatives } from "../../lib/voice/searchPick";

/** Songs shown under each track by `/mix list`, so a long queue fits a message. */
const LIST_QUEUE_SHOWN = 5;

const trackOption = (description: string, required: boolean) => (opt: SlashCommandIntegerOption) =>
	opt
		.setName("track")
		.setDescription(description)
		.setMinValue(1)
		.setRequired(required)
		.setAutocomplete(true);

const TRACK = "The track's number, as /mix list shows it";

export default {
	data: new SlashCommandBuilder()
		.setName("mix")
		.setDescription("Play tracks on top of the queue, each with its own queue and volume")
		.addSubcommand((sub) =>
			sub
				.setName("add")
				.setDescription("Queue a song on a mix track, or start a new track with it")
				.addStringOption((opt) =>
					opt
						.setName("search")
						.setDescription("A video link or a search on YouTube")
						.setRequired(true),
				)
				.addIntegerOption(
					trackOption("The track to queue it on; a new track if left empty", false),
				)
				.addNumberOption((opt) =>
					opt
						.setName("volume")
						.setDescription("The track's volume (0-500), 100 for a new one if left empty")
						.setMinValue(0)
						.setMaxValue(500),
				)
				.addNumberOption((opt) =>
					opt
						.setName("gap")
						.setDescription("Seconds of silence between the track's songs, 0 for a new one if left empty")
						.setMinValue(0)
						.setMaxValue(MAX_GAP_MS / 1000),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName("remove")
				.setDescription("Remove a mix track, or one song from its queue")
				.addIntegerOption(trackOption(TRACK, true))
				.addIntegerOption((opt) =>
					opt
						.setName("song")
						.setDescription("The song's place in the track's queue; the whole track if left empty")
						.setMinValue(1)
						.setAutocomplete(true),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName("skip")
				.setDescription("Move a mix track on to its next song now")
				.addIntegerOption(trackOption(TRACK, true)),
		)
		.addSubcommand((sub) =>
			sub
				.setName("volume")
				.setDescription("Set the volume of a mix track")
				.addIntegerOption(trackOption(TRACK, true))
				.addNumberOption((opt) =>
					opt
						.setName("volume")
						.setDescription("Its volume (0-500)")
						.setMinValue(0)
						.setMaxValue(500)
						.setRequired(true),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName("gap")
				.setDescription("Set how long a mix track waits between its songs")
				.addIntegerOption(trackOption(TRACK, true))
				.addNumberOption((opt) =>
					opt
						.setName("seconds")
						.setDescription("Seconds of silence between songs")
						.setMinValue(0)
						.setMaxValue(MAX_GAP_MS / 1000)
						.setRequired(true),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName("loop")
				.setDescription("Have a mix track play its queue round and round")
				.addIntegerOption(trackOption(TRACK, true))
				.addBooleanOption((opt) =>
					opt.setName("enabled").setDescription("On or off; toggles if left empty"),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName("main")
				.setDescription("Set the volume of the queue's song within the mix")
				.addNumberOption((opt) =>
					opt
						.setName("volume")
						.setDescription("Its volume (0-500)")
						.setMinValue(0)
						.setMaxValue(500)
						.setRequired(true),
				),
		)
		.addSubcommand((sub) =>
			sub.setName("list").setDescription("Show the mix's tracks and what each has queued"),
		),
	async autocomplete({ interaction }) {
		const mix = interaction.guildId ? findMix(interaction.guildId) : undefined;
		const focused = interaction.options.getFocused(true);
		if (focused.name === "song") {
			const track = mix?.at(interaction.options.getInteger("track") ?? 0);
			const labels = (track?.queue ?? []).map((song) => song.title);
			return interaction.respond(indexChoices(labels, String(focused.value)));
		}
		const labels = (mix?.list() ?? []).map((track) => {
			const song = track.playing ?? track.loading ?? track.queue[0];
			const queued = track.queue.length ? ` +${track.queue.length}` : "";
			return `${song?.title ?? "—"} (${track.volume}%)${queued}`;
		});
		return interaction.respond(indexChoices(labels, String(focused.value)));
	},
	async execute({ interaction, client, language }) {
		if (!interaction.guild)
			return await interaction.reply({
				content: languageText("server_only_command", language),
			});
		// Mixing happens in the Rust sidecar; the discord.js path has one
		// stream per guild and nowhere to put a second.
		if (!nativeVoiceActive())
			return await interaction.reply({
				content: languageText("mix_native_only", language),
			});
		const guildId = interaction.guild.id;
		const subcommand = interaction.options.getSubcommand(true);
		const mix = getMix(guildId);

		if (subcommand === "list") {
			return interaction.reply({
				content: listText(mix, language),
				flags: ["SuppressEmbeds"],
			});
		}

		// Everything else changes what the channel hears, so the same voice
		// checks as /volume apply.
		if (
			!interaction.member ||
			!("voice" in interaction.member) ||
			!interaction.member.voice.channel
		)
			return await interaction.reply({
				content: languageText("user_not_in_voice", language),
			});
		const botVoiceChannel = getBotVoiceChannel(interaction.guild, client);
		if (
			botVoiceChannel &&
			getConnection(guildId) &&
			interaction.member.voice.channel.id !== botVoiceChannel.id
		) {
			return await interaction.reply({
				content: languageText("not_same_voice", language),
			});
		}

		if (subcommand === "add") {
			const input = interaction.options.getString("search", true);
			const volume = interaction.options.getNumber("volume");
			const gap = interaction.options.getNumber("gap");
			const position = interaction.options.getInteger("track");
			const track = position === null ? undefined : mix.at(position);
			if (position !== null && !track)
				return interaction.reply(languageText("mix_no_track", language, { index: position }));
			if (isPlaylist(input))
				return interaction.reply(languageText("mix_video_only", language));
			if (!track && mix.isFull())
				return interaction.reply(languageText("mix_full", language));

			await interaction.deferReply();
			// Joined before the download, so the voice handshake and the
			// fetch overlap instead of queueing behind each other.
			const connection = ensureVoiceConnection(interaction);
			const player = getAudioPlayer(client, guildId, interaction.channel, language);
			if (!connection || !player)
				return interaction.editReply(misc.errorMessageObj(language));
			connection.subscribe(player);

			let url = input;
			// Kept so the user can switch to another hit afterwards
			let searchResults: YouTubeVideo[] = [];
			if (!isVideo(input)) {
				searchResults = await searchYouTube(input);
				if (!searchResults[0])
					return interaction.editReply(languageText("mix_not_found", language));
				url = searchResults[0].url;
			}
			const result = await queueOnTrack(guildId, url, {
				track,
				volume: volume ?? undefined,
				gapMs: gap === null ? undefined : gap * 1000,
			});
			if ("error" in result) {
				return interaction.editReply(
					result.error === "full"
						? languageText("mix_full", language)
						: result.error === "queue_full"
							? languageText("mix_queue_full", language)
							: languageText("mix_not_found", language),
				);
			}
			// Given for an existing track, they change it
			if (!result.created) {
				if (volume !== null) setTrackVolume(guildId, result.track, volume);
				if (gap !== null) mix.setGap(result.track, gap * 1000);
			}
			const trackNumber = mix.positionOf(result.track);
			const queuedAt = result.track.queue.indexOf(result.song);
			const playsNow = !result.track.playing && !result.track.loading && queuedAt === 0;
			dcb.log(`Queued ${result.song.url} on mix track ${result.track.id} in ${guildId} from /mix`);
			const reply = await interaction.editReply({
				content: languageText(
					result.created ? "mix_added_track" : playsNow ? "mix_playing_on" : "mix_queued",
					language,
					{
						title: result.song.title,
						url: result.song.url,
						track: trackNumber,
						volume: result.track.volume,
						position: queuedAt + 1,
					},
				),
				flags: ["SuppressEmbeds"],
			});
			await offerTrackAlternatives({
				interaction,
				language,
				guildId,
				track: result.track,
				song: result.song,
				results: searchResults,
				// The search's URL rather than the song's, which is the
				// video's canonical form and may not match it
				chosenUrl: url,
			});
			return reply;
		}

		if (!getConnection(guildId))
			return interaction.reply({
				content: languageText("not_connected", language),
			});

		if (subcommand === "main") {
			const volume = interaction.options.getNumber("volume", true);
			nativeSetMainVolume(guildId, volume);
			return interaction.reply(languageText("mix_main_set", language, { volume }));
		}

		const index = interaction.options.getInteger("track", true);
		const track = mix.at(index);
		if (!track)
			return interaction.reply(languageText("mix_no_track", language, { index }));

		switch (subcommand) {
			case "remove": {
				const songAt = interaction.options.getInteger("song");
				if (songAt === null) {
					removeTrack(guildId, track);
					return interaction.reply(languageText("mix_track_removed", language, { track: index }));
				}
				const removed = mix.removeSong(track, songAt - 1);
				if (!removed)
					return interaction.reply(
						languageText("mix_no_song", language, { track: index, index: songAt }),
					);
				return interaction.reply({
					content: languageText("mix_song_removed", language, {
						title: removed.title,
						url: removed.url,
						track: index,
					}),
					flags: ["SuppressEmbeds"],
				});
			}
			case "skip": {
				if (!track.playing && !track.queue.length)
					return interaction.reply(languageText("mix_skip_nothing", language, { track: index }));
				skipTrack(guildId, track);
				return interaction.reply(languageText("mix_skipped", language, { track: index }));
			}
			case "gap": {
				const seconds = interaction.options.getNumber("seconds", true);
				mix.setGap(track, seconds * 1000);
				return interaction.reply(
					languageText("mix_gap_set", language, { track: index, seconds: track.gapMs / 1000 }),
				);
			}
			case "loop": {
				track.loop = interaction.options.getBoolean("enabled") ?? !track.loop;
				return interaction.reply(
					languageText(track.loop ? "mix_loop_on" : "mix_loop_off", language, { track: index }),
				);
			}
		}

		// volume
		const volume = interaction.options.getNumber("volume", true);
		setTrackVolume(guildId, track, volume);
		return interaction.reply(languageText("mix_volume_set", language, { track: index, volume }));
	},
} as Command<SlashCommandBuilder>;

/** Every track, what it is playing and the start of its queue. */
function listText(mix: GuildMix, language: Language) {
	const now = Date.now();
	const lines = [languageText("mix_main_volume", language, { volume: mix.mainVolume })];
	if (!mix.size) lines.push(languageText("mix_empty", language));
	mix.list().forEach((track, i) => {
		lines.push("", trackHeader(track, i + 1, language));
		lines.push(trackState(mix, track, now, language));
		track.queue.slice(0, LIST_QUEUE_SHOWN).forEach((song, at) =>
			lines.push(
				languageText("mix_track_queue_item", language, {
					index: at + 1,
					title: song.title,
					url: song.url,
				}),
			),
		);
		const more = track.queue.length - LIST_QUEUE_SHOWN;
		if (more > 0) lines.push(languageText("mix_track_queue_more", language, { count: more }));
	});
	return lines.join("\n");
}

function trackHeader(track: MixTrack, index: number, language: Language) {
	const header = languageText("mix_track_header", language, {
		index,
		volume: track.volume,
		gap: track.gapMs / 1000,
	});
	return track.loop ? `${header}${languageText("mix_track_looping", language)}` : header;
}

function trackState(mix: GuildMix, track: MixTrack, now: number, language: Language) {
	if (track.playing) {
		const position = Math.floor((mix.position(track, now) ?? 0) / 1000);
		const length = track.playing.durationMs ? `/${timeFormat(track.playing.durationMs / 1000)}` : "";
		return languageText("mix_track_playing", language, {
			title: track.playing.title,
			url: track.playing.url,
			time: `${timeFormat(position)}${length}`,
		});
	}
	if (track.loading)
		return languageText("mix_track_loading", language, {
			title: track.loading.title,
			url: track.loading.url,
		});
	const due = mix.dueIn(track, now);
	if (due !== null)
		return languageText("mix_track_waiting", language, { seconds: Math.ceil(due / 1000) });
	return languageText("mix_track_silent", language);
}
