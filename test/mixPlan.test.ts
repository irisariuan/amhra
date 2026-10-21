import { describe, expect, test } from "bun:test";
import { gainFromPercent, GuildMix, MAX_LAYERS } from "../lib/voice/mixPlan";

/**
 * The bot's record of what each guild has mixed in over its queue. The audio
 * is the sidecar's; what can go wrong here is naming the wrong layer, or a late
 * report from the sidecar deleting one that is still playing.
 */

const track = (n: number) => ({
	trackId: `video${n}`,
	title: `Song ${n}`,
	url: `https://youtu.be/video${n}`,
	volume: 100,
});

describe("GuildMix", () => {
	test("lists layers in the order they were added, by 1-based position", () => {
		const mix = new GuildMix();
		mix.add(track(1));
		mix.add(track(2));
		expect(mix.at(1)?.title).toBe("Song 1");
		expect(mix.at(2)?.title).toBe("Song 2");
		expect(mix.at(0)).toBeUndefined();
		expect(mix.at(3)).toBeUndefined();
		expect(mix.at(1.5)).toBeUndefined();
	});

	test("never reuses an id, so a late finish cannot delete a newer layer", () => {
		// Removing fades the layer out and its layerFinished lands a frame
		// later. If the next layer had taken the same id, that report would
		// remove it.
		const mix = new GuildMix();
		const first = mix.add(track(1))!;
		mix.forget(first.id);
		const second = mix.add(track(2))!;
		expect(second.id).not.toBe(first.id);

		expect(mix.forget(first.id)).toBe(false);
		expect(mix.list()).toEqual([second]);
	});

	test("refuses a layer past the sidecar's cap", () => {
		const mix = new GuildMix();
		for (let n = 0; n < MAX_LAYERS; n++) expect(mix.add(track(n))).not.toBeNull();
		expect(mix.isFull()).toBe(true);
		expect(mix.add(track(99))).toBeNull();
		expect(mix.size).toBe(MAX_LAYERS);
	});

	test("sets a layer's volume by id, and reports an unknown one", () => {
		const mix = new GuildMix();
		const layer = mix.add(track(1))!;
		expect(mix.setVolume(layer.id, 40)).toBe(true);
		expect(mix.at(1)?.volume).toBe(40);
		expect(mix.setVolume("missing", 40)).toBe(false);
	});

	test("starts the queue song at full volume", () => {
		expect(new GuildMix().mainVolume).toBe(100);
	});
});

describe("gainFromPercent", () => {
	test("turns a percent into the sidecar's linear gain", () => {
		expect(gainFromPercent(100)).toBe(1);
		expect(gainFromPercent(250)).toBe(2.5);
		expect(gainFromPercent(-10)).toBe(0);
	});
});
