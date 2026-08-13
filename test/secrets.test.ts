import { afterEach, describe, expect, test } from "bun:test";
import { hasSecret, presentSecrets, requireSecret, secret } from "../lib/secrets";

/**
 * Credentials come from the environment. These tests pin the two behaviours
 * that are easy to get subtly wrong and expensive to get wrong: an unset
 * variable and a set-but-empty one must be treated the same, and asking for a
 * credential that is missing must fail here rather than somewhere far away.
 */

const NAMES = ["TOKEN", "TESTING_TOKEN", "OAUTH_TOKEN"] as const;
const saved = new Map<string, string | undefined>();

function set(name: string, value: string | undefined) {
	if (!saved.has(name)) saved.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

afterEach(() => {
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	saved.clear();
});

describe("secrets", () => {
	test("reads a credential from the environment", () => {
		set("TOKEN", "a-bot-token");
		expect(secret("TOKEN")).toBe("a-bot-token");
		expect(hasSecret("TOKEN")).toBe(true);
	});

	test("treats an empty variable as unset", () => {
		// `TOKEN=` in a .env is someone who has not filled it in, not someone
		// whose token is the empty string. Reporting it as present would make
		// the bot try to log in with nothing.
		set("TOKEN", "");
		expect(secret("TOKEN")).toBeUndefined();
		expect(hasSecret("TOKEN")).toBe(false);
	});

	test("missing credentials are undefined rather than empty strings", () => {
		set("OAUTH_TOKEN", undefined);
		expect(secret("OAUTH_TOKEN")).toBeUndefined();
	});

	test("requiring a missing credential fails with a message that says what to do", () => {
		set("OAUTH_TOKEN", undefined);
		expect(() => requireSecret("OAUTH_TOKEN")).toThrow(/OAUTH_TOKEN is not set/);
		expect(() => requireSecret("OAUTH_TOKEN")).toThrow(/\.env/);
	});

	test("requiring a present credential returns it", () => {
		set("OAUTH_TOKEN", "deadbeef");
		expect(requireSecret("OAUTH_TOKEN")).toBe("deadbeef");
	});

	test("lists which credentials are set without revealing them", () => {
		for (const name of NAMES) set(name, undefined);
		set("TOKEN", "one");
		set("OAUTH_TOKEN", "two");

		const present = presentSecrets();
		expect(present).toContain("TOKEN");
		expect(present).toContain("OAUTH_TOKEN");
		expect(present).not.toContain("TESTING_TOKEN");
		// Names only: this is meant to be safe to log.
		expect(JSON.stringify(present)).not.toContain("one");
	});
});
