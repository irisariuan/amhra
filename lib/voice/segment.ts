import z from "zod";
import { globalApp } from "../misc";

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
export const segmentsSchema = z.array(segmentSchema);
export type Segment = { segment: [number, number] } & z.infer<
	typeof segmentSchema
>;

export async function getSegments(
	id: string,
	categories: SegmentCategory[] = Object.values(SegmentCategory),
): Promise<Segment[] | null> {
	const url = new URL("https://sponsor.ajay.app/api/skipSegments");
	url.searchParams.set("videoID", id);
	url.searchParams.set(
		"categories",
		`[${categories.map((v) => `"${v}"`).join(",")}]`,
	);
	const res = await fetch(url);
	if (!res.ok) {
		globalApp.warn(
			`Failed to fetch ${id} with categories ${categories.join()}, Text:`,
			await res.text(),
		);
		return null;
	}
	const result = await segmentsSchema
		.parseAsync(await res.json().catch(() => null))
		.catch(() => null);
	if (!result) {
		globalApp.err(`Failed to parse segments for ${id}`);
		return null;
	}
	return result.filter(
		(v): v is Segment =>
			v.segment[0] !== undefined && v.segment[1] !== undefined,
	);
}
