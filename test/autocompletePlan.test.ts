import { describe, expect, test } from "bun:test";
import { indexChoices, MAX_CHOICES } from "../lib/autocompletePlan";

/**
 * Suggestions for options that pick an item by its place in a list. The value
 * handed back must stay the 1-based position the command already expects,
 * whatever narrowing the user typed.
 */

const songs = ["Never Gonna Give You Up", "Bad Apple", "Apple Pie", "Lemon"];

describe("indexChoices", () => {
	test("offers every item, numbered from 1, when nothing is typed", () => {
		expect(indexChoices(songs, "")).toEqual([
			{ name: "1. Never Gonna Give You Up", value: 1 },
			{ name: "2. Bad Apple", value: 2 },
			{ name: "3. Apple Pie", value: 3 },
			{ name: "4. Lemon", value: 4 },
		]);
	});

	test("matches text anywhere in the label, ignoring case, keeping positions", () => {
		expect(indexChoices(songs, " apple")).toEqual([
			{ name: "2. Bad Apple", value: 2 },
			{ name: "3. Apple Pie", value: 3 },
		]);
	});

	test("matches a number against positions starting with it", () => {
		const labels = Array.from({ length: 12 }, (_, i) => `Song ${i + 1}`);
		expect(indexChoices(labels, "1").map((c) => c.value)).toEqual([1, 10, 11, 12]);
	});

	test("stops at Discord's limit of 25", () => {
		const labels = Array.from({ length: 40 }, (_, i) => `Song ${i + 1}`);
		expect(indexChoices(labels, "")).toHaveLength(MAX_CHOICES);
	});

	test("keeps names within Discord's 100 characters", () => {
		const [choice] = indexChoices(["x".repeat(300)], "");
		expect(choice.name).toHaveLength(100);
		expect(choice.name.startsWith("1. x")).toBe(true);
		expect(choice.name.endsWith("…")).toBe(true);
	});

	test("offers nothing for an empty list", () => {
		expect(indexChoices([], "")).toEqual([]);
	});
});
