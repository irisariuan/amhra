import type { Account } from "@prisma/client";
import chalk from "chalk";
import { type NextFunction, type Request, type Response } from "express";
import type { CustomClient } from "../custom";
import { getAnonymousAccount, hasPermission } from "../db/account";
import { getLinkedUserGuilds } from "../auth/discord";
import { validateSession } from "../db/session";
import { Permission } from "../db/account";
import { exp, misc } from "../misc";

// Credential schemes carried in the Authorization header, set by the Next.js
// proxy from the session cookie, or by the visitor link for anonymous accounts.
//   Session <token>  -> web account
//   Anon <token>     -> anonymous account (Discord /dashboard link)
export function parseAuthScheme(
	header: string | undefined,
): { scheme: "session" | "anon"; token: string } | null {
	if (!header) return null;
	if (header.startsWith("Session ")) {
		return { scheme: "session", token: header.slice(8) };
	}
	if (header.startsWith("Anon ")) {
		return { scheme: "anon", token: header.slice(5) };
	}
	return null;
}

/** Resolves the account behind a request, or null if unauthenticated. */
export async function authenticate(req: Request): Promise<Account | null> {
	const parsed = parseAuthScheme(req.headers.authorization);
	if (!parsed) return null;
	if (parsed.scheme === "session") {
		return (await validateSession(parsed.token))?.account ?? null;
	}
	return getAnonymousAccount(parsed.token);
}

/**
 * Express middleware enforcing a minimum permission. The resolved account is
 * stored on `res.locals.account` for handlers. Anonymous accounts are accepted
 * only when `visitorAllowed` and the required permission is at most `User`.
 */
export function auth(permission: number = Permission.User, visitorAllowed = true) {
	return async (req: Request, res: Response, next: NextFunction) => {
		const formatter = misc.prefixFormatter(chalk.bgGrey(`(IP: ${req.ip})`));
		const account = await authenticate(req);
		if (!account) {
			exp.error(formatter("Auth failed (NO_SESSION)"));
			return res.sendStatus(401);
		}
		if (account.type === "anonymous") {
			if (!visitorAllowed || (permission & ~Permission.User) !== 0) {
				exp.error(formatter("Auth failed (ANON_FORBIDDEN)"));
				return res.sendStatus(403);
			}
		} else if (!hasPermission(account, permission)) {
			exp.error(
				formatter(
					`Auth failed for ${account.id} (perm ${account.permission}, need ${permission})`,
				),
			);
			return res.sendStatus(403);
		}
		res.locals.account = account;
		next();
	};
}

export function getRequestAccount(res: Response): Account | null {
	return (res.locals.account as Account | undefined) ?? null;
}

export function basicCheckBuilder(checklist: string[]) {
	return (req: Request, res: Response, next: NextFunction) => {
		for (const key of checklist) {
			if (!(key in (req.body ?? []))) {
				exp.error(
					`Missing '${key}' from requesting ${req.path} (Body: ${JSON.stringify(req.body)})`,
				);
				return res.sendStatus(400);
			}
		}
		next();
	};
}

/**
 * Whether an account may control a specific guild's player:
 *   - admins: any guild
 *   - anonymous accounts: guilds in their scope
 *   - Discord-linked web accounts: guilds they are a member of
 */
export async function accountCanAccessGuild(
	client: CustomClient,
	account: Account,
	guildId: string,
): Promise<boolean> {
	if (hasPermission(account, Permission.Admin)) return true;
	if (account.type === "anonymous") {
		return account.guildScope.includes(guildId);
	}
	const guildFound = await client.guilds.fetch(guildId).catch(() => null);
	if (!guildFound) return false;
	const userGuilds = await getLinkedUserGuilds(account.id);
	return !!userGuilds?.some(g => g.id === guildId);
}

/** Middleware form of {@link accountCanAccessGuild}, keyed on `req.body.guildId`. */
export function checkGuildMiddleware(client: CustomClient) {
	return async (req: Request, res: Response, next: NextFunction) => {
		const account = getRequestAccount(res);
		if (!account || !req.body?.guildId) return res.sendStatus(401);
		try {
			if (await accountCanAccessGuild(client, account, req.body.guildId)) {
				return next();
			}
			exp.error(`Guild ${req.body.guildId} not accessible for ${account.id}`);
			return res.sendStatus(403);
		} catch (err) {
			exp.error(`Guild access check failed: ${(err as Error).message}`);
			return res.sendStatus(500);
		}
	};
}
