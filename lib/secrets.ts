import "dotenv/config";

/**
 * Credentials, read from the environment rather than from `data/setting.json`.
 *
 * Everything here is a bearer credential: possession is authorisation. They are
 * kept out of the settings file because that file is edited through the
 * dashboard, served to it as a schema, written by the setup tools, and easy to
 * copy around while debugging — none of which should be true of a bot token.
 * `.env` is already gitignored and already loaded.
 *
 * Read through {@link secret} or {@link requireSecret} rather than reaching for
 * `process.env` directly, so there is one place that knows which names exist
 * and one error message when one is missing.
 */

/** Every credential the bot understands, and what it unlocks. */
export const SECRET_NAMES = {
	/** Production bot token. */
	TOKEN: "TOKEN",
	/** Development bot token, used when starting in dev mode. */
	TESTING_TOKEN: "TESTING_TOKEN",
	/** OAuth2 client secret, exchanged for user tokens by the dashboard. */
	OAUTH_TOKEN: "OAUTH_TOKEN",
} as const;

export type SecretName = keyof typeof SECRET_NAMES;

/**
 * Read a credential, or `undefined` when it is not set.
 *
 * An empty variable counts as unset: `TOKEN=` in a `.env` is someone who has
 * not filled it in yet, not someone whose token is the empty string.
 */
export function secret(name: SecretName): string | undefined {
	const value = process.env[name];
	return value && value.length > 0 ? value : undefined;
}

/**
 * Read a credential that the caller cannot proceed without.
 *
 * Throws rather than returning an empty string, because the alternative is a
 * failure much further away — a 401 from Discord, or a dashboard that accepts
 * every password.
 */
export function requireSecret(name: SecretName): string {
	const value = secret(name);
	if (!value) {
		throw new Error(
			`${name} is not set. Add it to .env — credentials no longer live in data/setting.json.`,
		);
	}
	return value;
}

/** Whether a credential is present, for choosing what the bot can start as. */
export function hasSecret(name: SecretName): boolean {
	return secret(name) !== undefined;
}

/**
 * Names that are set, for a startup line that says what is available without
 * saying what any of it is.
 */
export function presentSecrets(): SecretName[] {
	return (Object.keys(SECRET_NAMES) as SecretName[]).filter(hasSecret);
}
