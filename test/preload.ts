import { existsSync } from "node:fs";
import { provideSetting } from "../lib/setting";

/**
 * data/setting.json is written by the setup tool and gitignored, but
 * readSetting() throws without it, and tests reach it through
 * lib/voice/nativeBinary.ts. Without one, as on a fresh checkout or in CI,
 * they start from no settings: defaults are all they need.
 */
if (!existsSync(`${process.cwd()}/data/setting.json`)) provideSetting({});
