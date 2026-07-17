import type { Account, Session } from "@prisma/client";
import { misc } from "../misc";
import { hashToken } from "./account";
import { prisma } from "./core";

export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const SLIDING_REFRESH_MS = 1000 * 60 * 60 * 24; // extend at most once/day

/**
 * Issues a new session for an account and returns the raw session token. The
 * token is only ever returned here; the database stores its hash.
 */
export async function createSession(
	accountId: string,
	userAgent?: string,
): Promise<{ token: string; session: Session }> {
	const token = misc.generateToken(64);
	const session = await prisma.session.create({
		data: {
			tokenHash: hashToken(token),
			accountId,
			expiresAt: new Date(Date.now() + SESSION_TTL_MS),
			userAgent,
		},
	});
	return { token, session };
}

/**
 * Validates a raw session token and returns the owning account, sliding the
 * expiry forward. Expired sessions are deleted and rejected.
 */
export async function validateSession(
	token: string,
): Promise<{ account: Account; session: Session } | null> {
	const session = await prisma.session.findUnique({
		where: { tokenHash: hashToken(token) },
		include: { account: true },
	});
	if (!session) return null;
	if (session.expiresAt.getTime() < Date.now()) {
		await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
		return null;
	}
	if (Date.now() - session.lastUsedAt.getTime() > SLIDING_REFRESH_MS) {
		await prisma.session
			.update({
				where: { id: session.id },
				data: {
					lastUsedAt: new Date(),
					expiresAt: new Date(Date.now() + SESSION_TTL_MS),
				},
			})
			.catch(() => {});
	}
	return { account: session.account, session };
}

export async function deleteSession(token: string): Promise<void> {
	await prisma.session
		.delete({ where: { tokenHash: hashToken(token) } })
		.catch(() => {});
}

export async function deleteAllSessions(accountId: string): Promise<void> {
	await prisma.session.deleteMany({ where: { accountId } });
}

/** Removes expired sessions and challenges; call periodically. */
export async function collectGarbage(): Promise<void> {
	const now = new Date();
	await prisma.session.deleteMany({ where: { expiresAt: { lt: now } } });
	await prisma.webAuthnChallenge.deleteMany({
		where: { expiresAt: { lt: now } },
	});
	await prisma.account.deleteMany({
		where: { type: "anonymous", expiresAt: { lt: now } },
	});
}
