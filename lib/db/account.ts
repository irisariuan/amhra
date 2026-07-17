import type { Account, AccountType } from "@prisma/client";
import crypto from "node:crypto";
import { misc } from "../misc";
import { prisma } from "./core";

export const Permission = {
	User: 1 << 0,
	Admin: 1 << 1,
	HasSettings: 1 << 2,
} as const;

export function hasPermission(account: Account, permission: number): boolean {
	return (account.permission & permission) === permission;
}

/** Hashes a raw token for storage/lookup. Raw tokens are never persisted. */
export function hashToken(token: string): string {
	return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Creates an anonymous account scoped to one or more guilds, launched from the
 * Discord /dashboard command. Returns the raw token (shown once) and the account.
 */
export async function createAnonymousAccount(
	guildIds: string[],
	ttlMs = 1000 * 60 * 60 * 6,
): Promise<{ token: string; account: Account }> {
	const token = misc.generateToken(48);
	const account = await prisma.account.create({
		data: {
			type: "anonymous",
			permission: Permission.User,
			guildScope: guildIds,
			tokenHash: hashToken(token),
			expiresAt: new Date(Date.now() + ttlMs),
		},
	});
	return { token, account };
}

/** Resolves an anonymous account by its raw token, honouring expiry. */
export async function getAnonymousAccount(
	token: string,
): Promise<Account | null> {
	const account = await prisma.account.findUnique({
		where: { tokenHash: hashToken(token) },
	});
	if (!account || account.type !== "anonymous") return null;
	if (account.expiresAt && account.expiresAt.getTime() < Date.now()) {
		await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
		return null;
	}
	return account;
}

/** Reuses an active anonymous account for a guild, or creates a fresh one. */
export async function ensureAnonymousAccount(
	guildId: string,
): Promise<{ token: string; account: Account }> {
	return createAnonymousAccount([guildId]);
}

export async function createWebAccount(
	displayName?: string,
): Promise<Account> {
	return prisma.account.create({
		data: {
			type: "web",
			permission: Permission.User | Permission.HasSettings,
			displayName,
		},
	});
}

export function getAccountById(id: string): Promise<Account | null> {
	return prisma.account.findUnique({ where: { id } });
}

export async function anonymousAccountCanAccessGuild(
	account: Account,
	guildId: string,
): Promise<boolean> {
	return account.type === "anonymous" && account.guildScope.includes(guildId);
}

export type { Account, AccountType };
