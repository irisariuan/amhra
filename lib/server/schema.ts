import z from "zod";
import { SongEditType } from "./event";
import { isYouTubePlaylist, isYouTubeVideo } from "../youtube";
import { Language } from "../interaction";

// Queue item (from custom.ts)
export const QueueItemSchema = z.object({
	url: z.url(),
	repeating: z.boolean(),
	seek: z.number().nonnegative().optional(),
});

// Actions without meaningful detail (you pass {}):
const Base = {
	guildId: z.string().min(1, "guildId required"),
};

const PauseSchema = z.object({
	action: z.literal(SongEditType.Pause),
	...Base,
});
const ResumeSchema = z.object({
	action: z.literal(SongEditType.Resume),
	...Base,
});
const StopSchema = z.object({
	action: z.literal(SongEditType.Stop),
	...Base,
});
const SkipSchema = z.object({
	action: z.literal(SongEditType.Skip),
	...Base,
});
const QuitSchema = z.object({
	action: z.literal(SongEditType.Quit),
	...Base,
});
const MuteSchema = z.object({
	action: z.literal(SongEditType.Mute),
	...Base,
});
const UnmuteSchema = z.object({
	action: z.literal(SongEditType.Unmute),
	...Base,
});

const SkipSegmentSchema = z.object({
	action: z.literal(SongEditType.SkipSegment),
	...Base,
});

// SetTime: needs detail.sec >= 0
const SetTimeSchema = z.object({
	action: z.literal(SongEditType.SetTime),
	guildId: z.string(),
	detail: z.object({
		sec: z.number().int().nonnegative(),
	}),
});

// AddSong: requires detail.url
const AddSongSchema = z.object({
	action: z.literal(SongEditType.AddSong),
	guildId: z.string(),
	detail: z.object({
		url: z
			.string()
			.refine(
				(u) => isYouTubeVideo(u),
				"Must be a valid YouTube video URL",
			),
		force: z.boolean().default(false),
		seek: z.number().nonnegative().optional()
	}),
});

/**
 * AddPlaylist: queue every video of a YouTube playlist.
 *
 * `next` puts the set at the head of the queue, the dashboard's equivalent of
 * `/play next:true`. The videos are resolved server-side, so the dashboard only
 * has to hand over the link the user pasted.
 */
const AddPlaylistSchema = z.object({
	action: z.literal(SongEditType.AddPlaylist),
	guildId: z.string(),
	detail: z.object({
		url: z
			.string()
			.refine(
				(u) => isYouTubePlaylist(u),
				"Must be a valid YouTube playlist URL",
			),
		next: z.boolean().default(false),
		force: z.boolean().default(false),
	}),
});

// RemoveSong: requires detail.index
const RemoveSongSchema = z.object({
	action: z.literal(SongEditType.RemoveSong),
	guildId: z.string(),
	detail: z.object({
		index: z.number().int().nonnegative(),
	}),
});

// SetVolume: detail is a number (0..2) directly in body per core.ts logic
const SetVolumeSchema = z.object({
	action: z.literal(SongEditType.SetVolume),
	guildId: z.string(),
	detail: z.object({
		volume: z.number().nonnegative().max(5, "Volume must be <= 5"),
	}),
});

/**
 * SetCrossfade: the live per-guild version of the CROSSFADE_IN_MS setting.
 *
 * Bounded the same way the global setting is — a fade longer than a short
 * track would never finish before the next one began — and both halves are
 * optional so a slider can move one without knowing about the other.
 */
const SetCrossfadeSchema = z.object({
	action: z.literal(SongEditType.SetCrossfade),
	guildId: z.string(),
	detail: z
		.object({
			crossfadeMs: z.number().int().min(0).max(15_000).optional(),
			skipFadeMs: z.number().int().min(0).max(5_000).optional(),
		})
		.refine(
			(detail) =>
				detail.crossfadeMs !== undefined || detail.skipFadeMs !== undefined,
			{ message: "Give at least one of crossfadeMs or skipFadeMs" },
		),
});

// SetQueue: requires array of queue items
const SetQueueSchema = z.object({
	action: z.literal(SongEditType.SetQueue),
	guildId: z.string(),
	detail: z.object({
		queue: z.array(QueueItemSchema).min(1),
	}),
});

// Loop: expects boolean
const LoopSchema = z.object({
	action: z.literal(SongEditType.Loop),
	guildId: z.string(),
	detail: z.object({
		loop: z.boolean(),
	}),
});

// AutoSuggest (radio mode): expects boolean
const AutoSuggestSchema = z.object({
	action: z.literal(SongEditType.AutoSuggest),
	guildId: z.string(),
	detail: z.object({
		autoSuggest: z.boolean(),
	}),
});

/**
 * The mix: songs played on top of the queue, each at its own level. Volumes are
 * linear like SetVolume's, and a layer is named by the id `getData` reports,
 * which stays the same while others come and go.
 */
const MixVolume = z.number().nonnegative().max(5, "Volume must be <= 5");

const AddLayerSchema = z.object({
	action: z.literal(SongEditType.AddLayer),
	guildId: z.string(),
	detail: z.object({
		url: z
			.string()
			.refine((u) => isYouTubeVideo(u), "Must be a valid YouTube video URL"),
		volume: MixVolume.default(1),
	}),
});

const RemoveLayerSchema = z.object({
	action: z.literal(SongEditType.RemoveLayer),
	guildId: z.string(),
	detail: z.object({ id: z.string().min(1) }),
});

const SetLayerVolumeSchema = z.object({
	action: z.literal(SongEditType.SetLayerVolume),
	guildId: z.string(),
	detail: z.object({ id: z.string().min(1), volume: MixVolume }),
});

/** The queue track's own level within the mix, under the overall volume. */
const SetMainVolumeSchema = z.object({
	action: z.literal(SongEditType.SetMainVolume),
	guildId: z.string(),
	detail: z.object({ volume: MixVolume }),
});

/**
 * Trade a layer with the queue's song. Inaudible: each keeps its place and
 * volume, and the queue then controls the swapped-in song.
 */
const SwapLayerSchema = z.object({
	action: z.literal(SongEditType.SwapLayer),
	guildId: z.string(),
	detail: z.object({ id: z.string().min(1) }),
});

/**
 * Take a queued song out of the queue and mix it in now. `url`, when given,
 * is what the caller saw at `index`; a queue reordered in the meantime is
 * searched for it instead of mixing whatever moved into that place.
 */
const MixFromQueueSchema = z.object({
	action: z.literal(SongEditType.MixFromQueue),
	guildId: z.string(),
	detail: z.object({
		index: z.number().int().nonnegative(),
		url: z.string().optional(),
		volume: MixVolume.default(1),
	}),
});

// Discriminated union on action
export const SongEditRequestSchema = z.discriminatedUnion("action", [
	PauseSchema,
	ResumeSchema,
	StopSchema,
	SkipSchema,
	QuitSchema,
	MuteSchema,
	UnmuteSchema,
	SetTimeSchema,
	AddSongSchema,
	AddPlaylistSchema,
	RemoveSongSchema,
	SetVolumeSchema,
	SetCrossfadeSchema,
	SetQueueSchema,
	LoopSchema,
	AutoSuggestSchema,
	SkipSegmentSchema,
	AddLayerSchema,
	RemoveLayerSchema,
	SetLayerVolumeSchema,
	SetMainVolumeSchema,
	SwapLayerSchema,
	MixFromQueueSchema,
]);

// Inferred Type
export type SongEditRequest = z.infer<typeof SongEditRequestSchema>;

/**
 * A video to cut in at `at` (epoch milliseconds). Without `at`, only an
 * upcoming premiere is accepted, timed to its start.
 */
export const ScheduleAddSchema = z.object({
	...Base,
	url: z
		.string()
		.refine((u) => isYouTubeVideo(u), "Must be a valid YouTube video URL"),
	at: z.number().int().positive().optional(),
});

/** Answer a pending schedule: drop it, or queue it next instead of cutting in. */
export const ScheduleRespondSchema = z.object({
	...Base,
	id: z.string().min(1),
	action: z.enum(["cancel", "queue"]),
});

export const UserSettingUploadSchema = z.object({
	loop: z.boolean().optional(),
	language: z.enum(Language).optional(),
	autoSkip: z.boolean().optional(),
	autoSuggest: z.boolean().optional(),
});

/**
 * The editable global bot configuration. Required fields mirror
 * `data/settingSchema.json`; the remaining documented settings are optional
 * so existing installations can upgrade without first adding every key.
 *
 * Credentials are deliberately absent: they live in `.env` and are read through
 * `lib/secrets.ts`, so the dashboard can neither read them back nor overwrite
 * them with a PATCH.
 */
export const GlobalSettingSchema = z
	.object({
		PREFIX: z.string().optional(),
		CLIENT_ID: z.string(),
		REDIRECT_URI: z.string(),
		PRELOAD: z
			.array(z.enum(["errim", "error", "errwn", "express", "main"]))
			.optional(),
		RATE_LIMIT: z.number().int().optional(),
		DETAIL_LOGGING: z.boolean().optional(),
		QUEUE_SIZE: z.number().int().optional(),
		TEST_CLIENT_ID: z.string().optional(),
		PORT: z.number().int().min(0).max(65535).optional(),
		WEBSITE: z.string().nullable().optional(),
		HTTPS: z.boolean().optional(),
		USE_YOUTUBE_DL: z.boolean().optional(),
		SEEK: z.boolean().optional(),
		VOLUME_MODIFIER: z.number().optional(),
		AUTO_LEAVE: z.number().optional(),
		AUTO_LEAVE_ALONE: z.number().optional(),
		USE_COOKIES: z.boolean().optional(),
		BANNED_IDS: z.array(z.string()).optional(),
		MAX_CACHE_IN_GB: z.number().optional(),
		MAX_REPLAY_BUFFER_IN_SEC: z.number().min(0).optional(),
		MAX_STREAM_BUFFER_IN_MB: z.number().positive().optional(),
		MESSAGE_LOGGING: z.boolean().optional(),
		VOICE_LOGGING: z.boolean().optional(),
		// Bounded rather than merely positive: a fade longer than the shortest
		// plausible track would never finish before the next one started.
		CROSSFADE_IN_MS: z.number().int().min(0).max(15_000).optional(),
		SKIP_FADE_IN_MS: z.number().int().min(0).max(5_000).optional(),
		USE_NATIVE_FETCH: z.boolean().optional(),
		NATIVE_FETCH_BIN: z.string().optional(),
		USE_RUST_VOICE: z.boolean().optional(),
		NATIVE_NO_CACHE: z.boolean().optional(),
		NATIVE_VOICE_BIN: z.string().optional(),
		AUTO_SCHEDULE_PREMIERES: z.boolean().optional(),
		LYRICS_DELAY_MS: z.number().int().min(-10_000).max(10_000).optional(),
		VOICE_COMMANDS: z.boolean().optional(),
		VOICE_WAKE_MODEL: z.string().optional(),
		VOICE_WAKE_KEYWORDS: z.string().optional(),
		VOICE_WAKE_CLASSIFIER: z.string().optional(),
		VOICE_COLLECT_WAKE_CLIPS: z.boolean().optional(),
		VOICE_LOG_TRANSCRIPTS: z.boolean().optional(),
		VOICE_SPEECH: z.boolean().optional(),
		VOICE_SPEECH_THREADS: z.number().int().min(1).max(8).optional(),
		VOICE_WAKE_CHIME: z.boolean().optional(),
		VOICE_DUCK_VOLUME: z.number().min(0).max(1).optional(),
		VOICE_RECOGNISER_PROVIDER: z.enum(["cpu", "gpu", "coreml"]).optional(),
		VOICE_WAKE_PROVIDER: z.enum(["cpu", "gpu", "coreml"]).optional(),
		VOICE_SPEECH_PROVIDER: z.enum(["cpu", "gpu", "coreml"]).optional(),
		VOICE_INTENT_PROVIDER: z.enum(["cpu", "gpu", "coreml"]).optional(),
		VOICE_RECOGNISER_THREADS: z.number().int().min(1).max(32).optional(),
		VOICE_LANGUAGE: z.enum(["auto", "en", "zh", "ja", "ko", "yue"]).optional(),
		VOICE_WAIT_FOR_COMMAND_MS: z.number().int().min(500).max(10000).optional(),
		VOICE_END_SILENCE_MS: z.number().int().min(200).max(3000).optional(),
		VOICE_MAX_COMMAND_MS: z.number().int().min(2000).max(20000).optional(),
		VOICE_INTENT_MODEL_URL: z.string().optional(),
		VOICE_INTENT_MODEL: z.string().optional(),
		VOICE_INTENT_MODEL_SERVE: z.boolean().optional(),
	})
	.passthrough();