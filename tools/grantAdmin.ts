import "dotenv/config";
import { prisma } from "../lib/db/core";
import { Permission } from "../lib/db/account";

/**
 * Grants (or revokes) the Admin permission bit on a web account. Since the
 * shared admin password was removed, this is how the first administrator is
 * bootstrapped.
 *
 *   bun tools/grantAdmin.ts <accountId>            # grant admin
 *   bun tools/grantAdmin.ts <accountId> --revoke   # revoke admin
 */
async function main() {
	const accountId = process.argv[2];
	const revoke = process.argv.includes("--revoke");
	if (!accountId) {
		console.error("Usage: bun tools/grantAdmin.ts <accountId> [--revoke]");
		process.exit(1);
	}
	const account = await prisma.account.findUnique({ where: { id: accountId } });
	if (!account) {
		console.error(`No account with id ${accountId}`);
		process.exit(1);
	}
	const permission = revoke
		? account.permission & ~Permission.Admin
		: account.permission | Permission.Admin | Permission.HasSettings;
	await prisma.account.update({
		where: { id: accountId },
		data: { permission },
	});
	console.log(
		`${revoke ? "Revoked admin from" : "Granted admin to"} account ${accountId} (permission ${permission})`,
	);
	await prisma.$disconnect();
}

main();
