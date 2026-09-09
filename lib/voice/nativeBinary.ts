import { existsSync } from "node:fs";
import { type Setting, readSetting } from "../setting";

/**
 * Finding one of the Rust helper binaries, and deciding whether to use it.
 *
 * Both of them — amhra-fetch and amhra-sidecar — are opt-in by a setting, live
 * in the cargo build output unless a setting overrides the path, and are only
 * usable once that path exists. Written once here because the two answers have
 * to agree: a path read one way and existence checked against another is how a
 * feature ends up enabled against a binary nobody built.
 */
export interface NativeBinary {
	/** Where it should be, whether or not anything is there. */
	path(): string;
	/** Whether the setting asks for it at all. */
	enabled(): boolean;
	/** Whether it is actually there to run. */
	available(): boolean;
}

export function nativeBinary(
	use: (setting: Setting) => boolean | undefined,
	override: (setting: Setting) => string | undefined,
	// The cargo target directory is shared by the whole workspace, so only the
	// crate's own name differs between the two.
	crate: string,
): NativeBinary {
	const path = () =>
		override(readSetting()) ?? `${process.cwd()}/rust/target/release/${crate}`;
	return {
		path,
		enabled: () => use(readSetting()) === true,
		available: () => existsSync(path()),
	};
}
