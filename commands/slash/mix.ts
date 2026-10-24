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
import { nativeVoiceActive } from "../../lib/voice/native";
import {
	isFull,
	mixTracks,
	queueOnTrack,
	removeSong,
	removeTrack,
	setTrackGap,
	setTrackLoop,
	setTrackVolume,
	skipTrack,
	trackAt,
	trackVolume,
} from "../../lib/voice/mix";
import { MAX_GAP_MS } from "../../lib/voice/queuePlan";
import type { CustomAudioPlayer } from "../../lib/custom";
import { offerTrackAlternatives } from "../../lib/voice/searchPick";
import { QUEUE_OPTION, queueOf, queueOption, respondQueues } from "../../lib/voice/queueOption";

/** Songs shown under each track by `/mix list`, so a long queue fits a message. */
const LIST_QUEUE_SHOWN = 5;

/** Which mix track: a queue past the first, by its number. */
const trackOption = (description: string, required: boolean) => (opt: SlashCommandIntegerOption) =>
	queueOption(description)(opt).setMinValue(2).setRequired(required);

const TRACK = "The queue's number, 2 and up, as /mix list shows it";

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
					trackOption("The queue to put it on, 2 and up; a new queue if left empty", false),
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
	async autocomplete({ interaction, client, language }) {
		const guildId = interaction.guildId;
		const focused = interaction.options.getFocused(true);
		if (focused.name === "song") {
			const track = guildId ? trackAt(guildId, queueOf(interaction) ?? 0) : undefined;
			const labels = (track?.queue ?? []).map((song) => song.title ?? song.url);
			return interaction.respond(indexChoices(labels, String(focused.value)));
		}
		return respondQueues(interaction, client, language, {
			mixOnly: true,
			offerNew: interaction.options.getSubcommand(false) === "add",
		});
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

		if (subcommand === "list") {
			const main = getAudioPlayer(client, guildId, null, language, { createPlayer: false });
			return interaction.reply({
				content: listText(guildId, main?.mainVolume ?? 100, language),
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
			// A number that is not a queue yet starts one under it
			const number = queueOf(interaction) ?? undefined;
			const track = number === undefined ? undefined : trackAt(guildId, number);
			if (isPlaylist(input))
				return interaction.reply(languageText("mix_video_only", language));
			if (!track && isFull(guildId))
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
				channel: interaction.channel,
				number,
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
				if (volume !== null) setTrackVolume(result.track, volume);
				if (gap !== null) setTrackGap(result.track, gap * 1000);
			}
			const trackNumber = result.track.queueId;
			const queuedAt = result.track.queue.indexOf(result.song);
			const playsNow = !result.track.isPlaying && queuedAt === 0;
			dcb.log(`Queued ${result.song.url} on queue ${result.track.queueId} in ${guildId} from /mix`);
			const reply = await interaction.editReply({
				content: languageText(
					result.created ? "mix_added_track" : playsNow ? "mix_playing_on" : "mix_queued",
					language,
					{
						title: result.song.title ?? result.song.url,
						url: result.song.url,
						track: trackNumber,
						volume: trackVolume(result.track),
						position: queuedAt + 1,
					},
				),
				flags: ["SuppressEmbeds"],
			});
			await offerTrackAlternatives({
				interaction,
				language,
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
			getAudioPlayer(client, guildId, interaction.channel, language)?.setMainVolume(volume);
			return interaction.reply(languageText("mix_main_set", language, { volume }));
		}

		const index = interaction.options.getInteger(QUEUE_OPTION, true);
		const track = trackAt(guildId, index);
		if (!track)
			return interaction.reply(languageText("mix_no_track", language, { index }));

		switch (subcommand) {
			case "remove": {
				const songAt = interaction.options.getInteger("song");
				if (songAt === null) {
					removeTrack(track);
					return interaction.reply(languageText("mix_track_removed", language, { track: index }));
				}
				const removed = removeSong(track, songAt - 1);
				if (!removed)
					return interaction.reply(
						languageText("mix_no_song", language, { track: index, index: songAt }),
					);
				return interaction.reply({
					content: languageText("mix_song_removed", language, {
						title: removed.title ?? removed.url,
						url: removed.url,
						track: index,
					}),
					flags: ["SuppressEmbeds"],
				});
			}
			case "skip": {
				if (!track.isPlaying && !track.queue.length)
					return interaction.reply(languageText("mix_skip_nothing", language, { track: index }));
				skipTrack(track);
				return interaction.reply(languageText("mix_skipped", language, { track: index }));
			}
			case "gap": {
				const seconds = interaction.options.getNumber("seconds", true);
				setTrackGap(track, seconds * 1000);
				return interaction.reply(
					languageText("mix_gap_set", language, { track: index, seconds: track.gapMs / 1000 }),
				);
			}
			case "loop": {
				const loop = interaction.options.getBoolean("enabled") ?? !track.customSetting.looping;
				setTrackLoop(track, loop);
				return interaction.reply(
					languageText(loop ? "mix_loop_on" : "mix_loop_off", language, { track: index }),
				);
			}
		}

		// volume
		const volume = interaction.options.getNumber("volume", true);
		setTrackVolume(track, volume);
		return interaction.reply(languageText("mix_volume_set", language, { track: index, volume }));
	},
} as Command<SlashCommandBuilder>;

/** Every track, what it is playing and the start of its queue. */
function listText(guildId: string, mainVolume: number, language: Language) {
	const tracks = mixTracks(guildId);
	const lines = [languageText("mix_main_volume", language, { volume: mainVolume })];
	if (!tracks.length) lines.push(languageText("mix_empty", language));
	tracks.forEach((track) => {
		lines.push("", trackHeader(track, track.queueId, language));
		lines.push(trackState(track, language));
		track.queue.slice(0, LIST_QUEUE_SHOWN).forEach((song, at) =>
			lines.push(
				languageText("mix_track_queue_item", language, {
					index: at + 1,
					title: song.title ?? song.url,
					url: song.url,
				}),
			),
		);
		const more = track.queue.length - LIST_QUEUE_SHOWN;
		if (more > 0) lines.push(languageText("mix_track_queue_more", language, { count: more }));
	});
	return lines.join("\n");
}

function trackHeader(track: CustomAudioPlayer, index: number, language: Language) {
	const header = languageText("mix_track_header", language, {
		index,
		volume: trackVolume(track),
		gap: track.gapMs / 1000,
	});
	return track.customSetting.looping ? `${header}${languageText("mix_track_looping", language)}` : header;
}

function trackState(track: CustomAudioPlayer, language: Language) {
	const playing = track.isPlaying ? track.nowPlaying : null;
	if (playing) {
		const position = Math.floor((track.getCurrentSongPosition() ?? 0) / 1000);
		const seconds = playing.details.durationInSec;
		const length = seconds ? `/${timeFormat(seconds)}` : "";
		return languageText("mix_track_playing", language, {
			title: playing.title,
			url: playing.url,
			time: `${timeFormat(position)}${length}`,
		});
	}
	const due = track.dueInMs();
	if (due !== null)
		return languageText("mix_track_waiting", language, { seconds: Math.ceil(due / 1000) });
	return languageText("mix_track_silent", language);
}
