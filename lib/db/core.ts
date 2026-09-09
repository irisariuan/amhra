import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { globalApp } from "../misc";
import { requireSecret } from "../secrets";

/**
 * The database handle.
 *
 * Prisma 7 removed `url` from the datasource block, so the connection string is
 * handed to the client here through a driver adapter instead of being resolved
 * out of the schema. `requireSecret` means an unset DATABASE_URL fails at
 * startup with a message naming the variable, rather than at the first query.
 */
const adapter = new PrismaPg({
	connectionString: requireSecret("DATABASE_URL"),
});

export const prisma = new PrismaClient({ adapter });

process.on("exit", async () => {
	globalApp.important("Disconnecting from database");
	await prisma.$disconnect();
});
