import chalk from "chalk";
import { NextFunction, type Request, type Response } from "express";
import { CustomClient } from "../custom";
import { getUser, hasUser } from "../db/core";
import { misc, exp } from "../misc";
import crypto from "node:crypto";
import { readSetting } from "../setting";

const setting = readSetting(`${process.cwd()}/data/setting.json`);

export function auth(permission: number = 0) {
	return async (req: Request, res: Response, next: NextFunction) => {
		const formatter = misc.prefixFormatter(
			`${chalk.bgGrey(`(IP: ${req.ip})`)}`,
		);
		if (!req.headers.authorization) {
			exp.error(formatter("Auth failed (NOT_FOUND)"));
			return res.sendStatus(401);
		}
		//op token
		if (req.headers.authorization.startsWith("Basic")) {
			const auth = Buffer.from(req.headers.authorization, "utf8");
			const hashed = crypto
				.createHash("sha256")
				.update(auth)
				.digest("hex");
			if (
				crypto.timingSafeEqual(
					Buffer.from(hashed, "hex"),
					Buffer.from(setting.AUTH_TOKEN, "hex"),
				)
			) {
				return next();
			}
			exp.error(formatter("Auth failed (FORBIDDEN, OP Token)"));
			return res.sendStatus(401);
		}
		//bearer
		if (req.headers.authorization.startsWith("Bearer")) {
			const user = await getUser(req.headers.authorization);
			if (!user) return res.sendStatus(401);
			if ((user.permission & permission) !== permission) {
				exp.error(
					formatter(
						`Auth failed for user ${user.id} (FORBIDDEN, Permission: ${user.permission}, Required: ${permission})`,
					),
				);
				return res.sendStatus(403);
			}
			return next();
		}
		// visitor (no prefix token)
		if (permission === 0) {
			return next();
		}
		exp.error(formatter("Auth failed (FORBIDDEN, Unknown method)"));
		return res.sendStatus(401);
	};
}

export function basicCheckBuilder(checklist: string[]) {
	return (req: Request, res: Response, next: NextFunction) => {
		for (const i of checklist) {
			if (!(i in (req.body ?? []))) {
				exp.error(
					`Missing '${i}' from requesting ${req.path} (Body: ${JSON.stringify(
						req.body,
					)})`,
				);
				return res.sendStatus(400);
			}
		}
		next();
	};
}

export function checkGuildMiddleware(client: CustomClient) {
	return (req: Request, res: Response, next: NextFunction) => {
		if (!req.headers.authorization || !req.body?.guildId)
			return res.sendStatus(401);
		checkTokenWithGuild(client, req.headers.authorization, req.body.guildId)
			.then((canAccess) => {
				if (canAccess) return next();
				exp.error(
					`Guild not found or token invalid for guild ${req.body.guildId}`,
				);
				return res.sendStatus(401);
			})
			.catch((err: Error) => {
				exp.error(
					`Error occurred when validating token for guild: ${err.message}`,
				);
				return res.sendStatus(500);
			});
	};
}

/**
 * Will not actively check OP token, please use auth middleware for that
 *
 * Only check if the token can access the guild
 */
export async function checkTokenWithGuild(
	client: CustomClient,
	auth: string,
	guildId: string,
): Promise<boolean> {
	if (auth.startsWith("Basic")) return true;
	if (auth.startsWith("Bearer")) {
		auth = misc.removeBearer(auth);
		const guildFound = await client.guilds.fetch(guildId).catch(() => null);
		if (!guildFound) return false;
		const userFound = await getUser(auth);
		if (!userFound) return false;
		return !!guildFound.members.fetch(userFound.id).catch(() => null);
	}
	const visitorToken = client.getToken(guildId)?.token;
	if (!visitorToken) return false;
	return crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(visitorToken));
}
