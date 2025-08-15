import chalk from "chalk";
import { NextFunction, type Request, type Response } from "express";
import { CustomClient } from "../custom";
import { hasUser } from "../db/core";
import { misc, exp } from "../misc";
import crypto from "node:crypto";
import { readSetting } from "../setting";

const setting = readSetting(`${process.cwd()}/data/setting.json`);

interface AuthOptions {
	requirePassword: boolean;
	allowBearer: boolean;
}

export function auth(
	authOptions: AuthOptions = { requirePassword: true, allowBearer: false },
) {
	return async (req: Request, res: Response, next: NextFunction) => {
		const formatter = misc.prefixFormatter(
			`${chalk.bgGrey(`(IP: ${req.ip})`)}`,
		);
		if (!req.headers.authorization) {
			exp.error(formatter("Auth failed (NOT_FOUND)"));
			return res.sendStatus(401);
		}
		if (
			authOptions.allowBearer &&
			req.headers.authorization.startsWith("Bearer")
		) {
			if (await hasUser(misc.removeBearer(req.headers.authorization))) {
				return next();
			}
			exp.error(formatter("Auth failed (NOT_MATCHING_DB)"));
		}
		if (
			authOptions.requirePassword ||
			req.headers.authorization.startsWith("Basic")
		) {
			if (!req.headers.authorization.startsWith("Basic")) {
				return res.sendStatus(401);
			}
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
			exp.error(formatter("Auth failed (NOT_MATCHING)"));
		}
		if (
			!authOptions.requirePassword &&
			!req.headers.authorization.startsWith("Basic") &&
			!req.headers.authorization.startsWith("Bearer")
		) {
			return next();
		}
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
		if (!req.headers.authorization) return res.sendStatus(401);
		if (
			checkBearerWithGuild(
				client,
				req.headers.authorization,
				req.body?.guildId,
			)
		) {
			return next();
		}
		exp.error("Guild not found");
		res.sendStatus(401);
	};
}

export function checkBearerWithGuild(
	client: CustomClient,
	auth: string,
	guildId: string | null = null,
) {
	const token = guildId && client.getToken(guildId)?.token;
	if (
		auth.startsWith("Basic") ||
		(token &&
			crypto.timingSafeEqual(
				Buffer.from(token),
				Buffer.from(misc.removeBearer(auth)),
			))
	) {
		return true;
	}
	return false;
}
