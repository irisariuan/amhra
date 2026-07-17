import bodyParser from "body-parser";
import chalk from "chalk";
import express, { type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import NodeCache from "node-cache";
import { getYouTubeVideoInfo, isYouTubeVideo, searchYouTube } from "../youtube";
import type { CustomClient } from "../custom";
import {
	getPlayingGuildsForAccount,
	resolveDiscordLogin,
	unlinkDiscord,
} from "../auth/discord";
import { Permission, hasPermission } from "../db/account";
import {
	beginAddCredential,
	beginAuthentication,
	beginRegistration,
	finishAuthentication,
	finishRegistration,
} from "../auth/webauthn";
import { createSession, deleteSession, collectGarbage } from "../db/session";
import { getSuggestions } from "../voice/suggest";
import { load } from "../log/load";
import { exp, globalApp, misc } from "../misc";
import { readSetting, reloadSetting, writeJsonSync } from "../setting";
import {
	accountCanAccessGuild,
	auth,
	basicCheckBuilder,
	checkGuildMiddleware,
	getRequestAccount,
	parseAuthScheme,
} from "./auth";
import { ActionType, event } from "./event";
import {
	GlobalSettingSchema,
	SongEditRequestSchema,
	UserSettingUploadSchema,
} from "./schema";
import { handleSongInterruption } from "./songEdit";
import editAccountSetting, { getAccountSetting } from "../db/accountSetting";

const setting = readSetting(`${process.cwd()}/data/setting.json`);
const privateGlobalSettingKeys = new Set([
	"TOKEN",
	"TESTING_TOKEN",
	"OAUTH_TOKEN",
	"AUTH_TOKEN",
]);

function publicGlobalSettings(settings: object) {
	return Object.fromEntries(
		Object.entries(settings).filter(
			([key]) => !privateGlobalSettingKeys.has(key),
		),
	);
}

/** Public projection of an account for the dashboard. */
function publicAccount(account: {
	id: string;
	type: string;
	displayName: string | null;
	permission: number;
}) {
	return {
		id: account.id,
		type: account.type,
		displayName: account.displayName,
		permission: account.permission,
		isAdmin: (account.permission & Permission.Admin) === Permission.Admin,
	};
}

export async function initServer(client: CustomClient) {
	const app = express();
	const jsonParser = bodyParser.json();

	const logQueue = await load(...(setting.PRELOAD ?? []));
	const videoCache = new NodeCache({ stdTTL: 60 * 60 * 24 * 5 });

	// Periodically prune expired sessions, challenges, and anonymous accounts.
	setInterval(() => collectGarbage().catch(() => {}), 1000 * 60 * 30);

	app.use((req, res, next) => {
		event.emitPage(req.path);
		if (setting?.DETAIL_LOGGING) {
			exp.log(
				misc.prefixFormatter(chalk.bgGrey(`(IP: ${req.ip})`))(
					`Requested page ${req.path}`,
				),
			);
		}
		next();
	});

	if (setting.RATE_LIMIT > 0) {
		app.use(
			rateLimit({
				windowMs: 5 * 60 * 1000,
				limit: setting.RATE_LIMIT,
				standardHeaders: "draft-7",
				legacyHeaders: false,
			}),
		);
		app.set("trust proxy", 1);
	} else {
		globalApp.warn("API rate limit disabled");
	}

	event.on("log", (msg, type) => {
		if (type.startsWith("exp") && !setting.DETAIL_LOGGING) return;
		if (setting.QUEUE_SIZE > 0 && logQueue.length >= setting.QUEUE_SIZE) {
			logQueue.splice(0, logQueue.length - setting.QUEUE_SIZE);
		}
		logQueue.push({ message: msg, type, time: Date.now() });
	});

	// ---- Authentication: passkeys, sessions, Discord linking ----

	app.post(
		"/api/auth/passkey/register/begin",
		jsonParser,
		async (req, res) => {
			const { options, challengeId } = await beginRegistration(
				req.body?.displayName,
			);
			res.json({ challengeId, options });
		},
	);

	app.post(
		"/api/auth/passkey/register/finish",
		jsonParser,
		basicCheckBuilder(["challengeId", "response"]),
		async (req, res) => {
			const result = await finishRegistration(
				req.body.challengeId,
				req.body.response,
			);
			if (!result) return res.sendStatus(400);
			const { token } = await createSession(
				result.accountId,
				req.headers["user-agent"],
			);
			res.json({ token });
		},
	);

	app.post("/api/auth/passkey/login/begin", async (_req, res) => {
		const { options, challengeId } = await beginAuthentication();
		res.json({ challengeId, options });
	});

	app.post(
		"/api/auth/passkey/login/finish",
		jsonParser,
		basicCheckBuilder(["challengeId", "response"]),
		async (req, res) => {
			const result = await finishAuthentication(
				req.body.challengeId,
				req.body.response,
			);
			if (!result) return res.sendStatus(401);
			const { token } = await createSession(
				result.accountId,
				req.headers["user-agent"],
			);
			res.json({ token });
		},
	);

	app.post(
		"/api/auth/passkey/add/begin",
		auth(Permission.User, false),
		async (_req, res) => {
			const account = getRequestAccount(res);
			if (!account) return res.sendStatus(401);
			const { options, challengeId } = await beginAddCredential(
				account.id,
			);
			res.json({ challengeId, options });
		},
	);

	app.post(
		"/api/auth/passkey/add/finish",
		jsonParser,
		auth(Permission.User, false),
		basicCheckBuilder(["challengeId", "response"]),
		async (req, res) => {
			const result = await finishRegistration(
				req.body.challengeId,
				req.body.response,
			);
			return res.sendStatus(result ? 200 : 400);
		},
	);

	app.get("/api/auth/session", auth(Permission.User), (_req, res) => {
		const account = getRequestAccount(res);
		if (!account) return res.sendStatus(401);
		res.json({ account: publicAccount(account) });
	});

	app.post("/api/auth/logout", async (req, res) => {
		const parsed = parseAuthScheme(req.headers.authorization);
		if (parsed?.scheme === "session") await deleteSession(parsed.token);
		res.sendStatus(200);
	});

	// Discord OAuth: log in via linked identity, or link to the current account.
	app.post(
		"/api/auth/discord/callback",
		jsonParser,
		basicCheckBuilder(["code"]),
		async (req, res) => {
			let linkTo: string | undefined;
			const parsed = parseAuthScheme(req.headers.authorization);
			if (parsed?.scheme === "session") {
				const account = getRequestAccount(res);
				linkTo = account?.id;
			}
			const account = await resolveDiscordLogin(req.body.code, linkTo);
			if (!account) return res.sendStatus(400);
			const { token } = await createSession(
				account.id,
				req.headers["user-agent"],
			);
			res.json({ token, account: publicAccount(account) });
		},
	);

	app.post(
		"/api/auth/discord/unlink",
		auth(Permission.User, false),
		async (_req, res) => {
			const account = getRequestAccount(res);
			if (!account) return res.sendStatus(401);
			await unlinkDiscord(account.id);
			res.sendStatus(200);
		},
	);

	// ---- Logs (admin) ----

	app.get("/api/log", auth(Permission.Admin, false), (_req, res) => {
		res.send(JSON.stringify({ content: logQueue }));
	});

	// ---- Player control ----

	app.post(
		"/api/song/edit",
		jsonParser,
		auth(Permission.User),
		basicCheckBuilder(["action", "guildId"]),
		checkGuildMiddleware(client),
		async (req: Request, res: Response) => {
			const parsed = SongEditRequestSchema.safeParse(req.body);
			if (!parsed.success) {
				exp.error(
					misc.prefixFormatter(
						chalk.bgGrey(`(Guild ID: ${req.body.guildId})`),
					)(`Request body error ${parsed.error.message}`),
				);
				return res.sendStatus(400);
			}
			return res.sendStatus(
				await handleSongInterruption(client, parsed.data),
			);
		},
	);

	// ---- Global bot configuration (admin-only) ----

	app.get("/api/admin/settings", auth(Permission.Admin, false), (_req, res) =>
		res.json(publicGlobalSettings(readSetting())),
	);

	app.post(
		"/api/admin/settings",
		jsonParser,
		auth(Permission.Admin, false),
		(req, res) => {
			const patchResult = GlobalSettingSchema.partial().safeParse(
				req.body,
			);
			if (!patchResult.success) return res.sendStatus(400);

			// Only accept fields described by settingSchema.json. The current
			// configuration is preserved so undocumented legacy values survive edits.
			const patch = Object.fromEntries(
				Object.keys(GlobalSettingSchema.shape)
					.filter(
						(key) =>
							key in patchResult.data &&
							!privateGlobalSettingKeys.has(key),
					)
					.map((key) => [
						key,
						patchResult.data[key as keyof typeof patchResult.data],
					]),
			);
			const nextResult = GlobalSettingSchema.safeParse({
				...readSetting(),
				...patch,
			});
			if (!nextResult.success) return res.sendStatus(400);

			try {
				writeJsonSync(
					`${process.cwd()}/data/setting.json`,
					nextResult.data,
				);
				reloadSetting();
				return res.json(publicGlobalSettings(nextResult.data));
			} catch (error) {
				exp.error(`Failed to save global settings: ${error}`);
				return res.sendStatus(500);
			}
		},
	);

	app.post(
		"/api/action",
		jsonParser,
		auth(Permission.Admin, false),
		basicCheckBuilder(["action"]),
		(req, res) => {
			const formatter = misc.prefixFormatter(
				chalk.bgGrey(`(IP: ${req.ip})`),
			);
			exp.log(formatter("Received action request"));
			switch (req.body.action as ActionType) {
				case ActionType.Exit:
					globalApp.important(
						formatter("Received exit request, exiting..."),
					);
					res.sendStatus(200);
					return process.exit(0);
				case ActionType.ReloadCommands:
					globalApp.important(formatter("Reloading commands..."));
					event.emitReloadCommands();
					return res.sendStatus(200);
				case ActionType.ReloadSetting:
					globalApp.important(formatter("Reloading settings..."));
					reloadSetting();
					return res.sendStatus(200);
				default:
					exp.log(`Action not recognized (${req.body.action})`);
					return res.sendStatus(400);
			}
		},
	);

	app.post(
		"/api/search",
		jsonParser,
		auth(Permission.User),
		basicCheckBuilder(["query"]),
		async (req, res) => {
			exp.log(`Queried ${req.body.query}`);
			const fetched = await searchYouTube(req.body.query).catch(
				() => null,
			);
			if (!fetched || !fetched[0]) {
				exp.error(`Search failed for query: ${req.body.query}`);
				return res.sendStatus(500);
			}
			const searched = fetched[0];
			return res.json({
				url: searched.url,
				title: searched.title,
				durationInSec: searched.durationInSec,
			});
		},
	);

	app.post(
		"/api/getVideoDetail",
		jsonParser,
		auth(Permission.User),
		basicCheckBuilder(["url"]),
		async (req, res) => {
			if (!req.body.url || !isYouTubeVideo(req.body.url)) {
				return res.sendStatus(400);
			}
			try {
				if (videoCache.has(req.body.url)) {
					return res.send(
						JSON.stringify(videoCache.get(req.body.url)),
					);
				}
				const video = (await getYouTubeVideoInfo(req.body.url))
					.video_details;
				if (!video) return res.sendStatus(404);
				videoCache.set(req.body.url, video);
				return res.send(JSON.stringify(video));
			} catch {
				res.sendStatus(500);
			}
		},
	);

	// Song suggestions for a guild's current/recent tracks (dashboard panel).
	app.get(
		"/api/suggestions/:guildId",
		auth(Permission.User),
		async (req, res) => {
			const account = getRequestAccount(res);
			if (
				!account ||
				!(await accountCanAccessGuild(
					client,
					account,
					req.params.guildId,
				))
			) {
				return res.sendStatus(403);
			}
			const player = client.player.get(req.params.guildId);
			const seed =
				player?.nowPlaying?.url ?? player?.history.at(-1) ?? null;
			if (!seed) return res.json({ content: [] });
			const content = await getSuggestions(seed, player?.history ?? []);
			return res.json({ content });
		},
	);

	app.post(
		"/api/live",
		jsonParser,
		auth(Permission.User),
		basicCheckBuilder(["guildId"]),
		checkGuildMiddleware(client),
		async (_req, res) => {
			return res.sendStatus(200);
		},
	);

	app.get(
		"/api/playingGuildIds",
		auth(Permission.User),
		async (_req, res) => {
			const account = getRequestAccount(res);
			if (!account) return res.sendStatus(401);
			if (hasPermission(account, Permission.Admin)) {
				const content = await Promise.all(
					Array.from(client.player.keys()).map(async (id) => ({
						id,
						name: (await client.guilds.fetch(id)).name ?? null,
					})),
				);
				return res.json({ content });
			}
			if (account.type === "anonymous") {
				const content = await Promise.all(
					account.guildScope
						.filter((id) => client.player.has(id))
						.map(async (id) => ({
							id,
							name: (await client.guilds.fetch(id)).name ?? null,
						})),
				);
				return res.json({ content });
			}
			return res.json({
				content: await getPlayingGuildsForAccount(account.id),
			});
		},
	);

	app.get(
		"/api/guildIds/all",
		auth(Permission.Admin, false),
		async (_req, res) => {
			const content = (await client.guilds.fetch()).map((v) => ({
				id: v.id,
				name: v.name,
			}));
			res.json({ content });
		},
	);

	app.get(
		"/api/song/get/:guildId",
		auth(Permission.User),
		async (req, res) => {
			const account = getRequestAccount(res);
			if (
				!account ||
				!(await accountCanAccessGuild(
					client,
					account,
					req.params.guildId,
				))
			) {
				return res.sendStatus(403);
			}
			const data = client.player.get(req.params.guildId)?.getData();
			return res.send(JSON.stringify(data ?? null));
		},
	);

	// ---- Per-account settings ----

	app.get(
		"/api/setting",
		auth(Permission.HasSettings, false),
		async (_req, res) => {
			const account = getRequestAccount(res);
			if (!account) return res.sendStatus(401);
			const s = (await getAccountSetting(account.id)) ?? {
				autoSkipNonMusic: false,
				loop: false,
				autoSuggest: false,
				language: "en" as const,
			};
			return res.json({
				accountId: account.id,
				autoSkip: s.autoSkipNonMusic,
				loop: s.loop,
				autoSuggest: s.autoSuggest,
				language: s.language,
			});
		},
	);

	app.post(
		"/api/setting",
		jsonParser,
		auth(Permission.HasSettings, false),
		async (req, res) => {
			const { success, data } = UserSettingUploadSchema.safeParse(
				req.body,
			);
			const account = getRequestAccount(res);
			if (!success || !account) return res.sendStatus(400);
			await editAccountSetting(account.id, {
				autoSkipSegment: data.autoSkip,
				language: data.language,
				looping: data.loop,
				autoSuggest: data.autoSuggest,
			})
				.then(() => res.sendStatus(200))
				.catch((err) => {
					exp.error(`Failed to edit account setting: ${err}`);
					res.sendStatus(500);
				});
		},
	);

	return app;
}
