import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * CLI-side Prisma configuration.
 *
 * Prisma 7 stopped reading `url` from the datasource block, so the connection
 * string reaches the CLI here and the running bot through the driver adapter in
 * lib/db/core.ts. The two halves are deliberately separate: only the CLI needs
 * credentials able to migrate the schema.
 *
 * Prisma 7 also stopped loading `.env` on its own, hence the dotenv import —
 * without it `migrate` and `db push` see no DATABASE_URL even when the bot does.
 *
 * Read straight from `process.env` rather than through the `env()` helper: that
 * helper throws while the config is being loaded, which fails every command —
 * `generate`, `validate`, even `--help` — on a checkout with no database. Only
 * migrate and introspect actually need a URL, and they report a missing one
 * themselves.
 */
export default defineConfig({
	schema: "prisma/schema.prisma",
	datasource: {
		url: process.env.DATABASE_URL,
	},
});
