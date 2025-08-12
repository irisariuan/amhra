import z from "zod";
import { SongEditType } from "../express/event";
import { YoutubeVideoRegex } from "./server";

// Queue item (from custom.ts)
export const QueueItemSchema = z.object({
	url: z.url(),
	repeating: z.boolean(),
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
	...Base
})

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
				(u) => YoutubeVideoRegex.test(u),
				"Must be a valid YouTube video URL",
			),
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

// SetVolume: detail is a number (0..2) directly in body per server.ts logic
const SetVolumeSchema = z.object({
	action: z.literal(SongEditType.SetVolume),
	guildId: z.string(),
	detail: z.object({
		volume: z.number().nonnegative().max(5, "Volume must be <= 5"),
	}),
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
	RemoveSongSchema,
	SetVolumeSchema,
	SetQueueSchema,
	LoopSchema,
]);

// Inferred Type
export type SongEditRequest = z.infer<typeof SongEditRequestSchema>;
