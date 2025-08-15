import bodyParser from "body-parser";
import chalk from "chalk";
import type { TextChannel } from "discord.js";
import express, { type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import NodeCache from "node-cache";
import { search, video_info } from "play-dl";
import youtubeSuggest from "youtube-suggest";
import { type Guild, getUserGuilds, register } from "../auth/core";
import type { CustomClient } from "../custom";
import { getUser } from "../db/core";
import { load } from "../log/load";
import { exp, globalApp, misc } from "../misc";
import { readSetting, reloadSetting } from "../setting";
import {
	auth,
	basicCheckBuilder,
	checkBearerWithGuild,
	checkGuildMiddleware,
} from "./auth";
import { ActionType, event } from "./event";
import { SongEditRequestSchema } from "./schema";
import { handleSongInterruption } from "./songEdit";

export const YoutubeVideoRegex =
	/^http(?:s?):\/\/(?:www\.)?youtu(?:be\.com\/watch\?v=|\.be\/)([\w\-_]*)(&(amp;)?[\w?=]*)?$/;
export interface Message {
	message: {
		content: string;
		id: string;
	};
	author: {
		id: string;
		tag: string;
	};
	timestamp: {
		createdAt: number;
		editedAt?: number;
	};
}
const setting = readSetting(`${process.cwd()}/data/setting.json`);

export async function initServer(client: CustomClient) {
	const app = express();
	const jsonParser = bodyParser.json();

	const logQueue = await load(...(setting.PRELOAD ?? []));
	// TTL set to 5 days
	const videoCache = new NodeCache({ stdTTL: 60 * 60 * 24 * 5 });
	const userGuildCache = new NodeCache({ stdTTL: 60 * 60 * 3 });

	app.use((req, res, next) => {
		const formatter = misc.prefixFormatter(
			`${chalk.bgGrey(`(IP: ${req.ip})`)}`,
		);

		event.emitPage(req.path);
		if (setting?.DETAIL_LOGGING) {
			exp.log(formatter(`Requested page ${req.path}`));
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
		if (type.startsWith("exp") && !setting.DETAIL_LOGGING) {
			return;
		}
		if (setting.QUEUE_SIZE > 0 && logQueue.length >= setting.QUEUE_SIZE) {
			logQueue.splice(0, logQueue.length - setting.QUEUE_SIZE);
		}
		logQueue.push({ message: msg, type, time: Date.now() });
	});

	event.on("page", (pageName) => exp.log(`Fetched page ${pageName}`));

	app.post(
		"/api/register",
		jsonParser,
		basicCheckBuilder(["code"]),
		async (req, res) => {
			if (!req.body.code) {
				return res.sendStatus(400);
			}
			const result = await register(req.body.code);
			if (!result) {
				return res.sendStatus(400);
			}
			return res.send(JSON.stringify({ token: result.accessToken }));
		},
	);

	app.get(
		"/api/new",
		auth({ allowBearer: true, requirePassword: true }),
		(req, res) => {
			if (req.headers["origin-ip"]) {
				exp.log(
					`New IP fetched: ${req.headers["origin-ip"]} (${req.ip})`,
				);
			} else {
				exp.log(`New IP fetched: ${req.ip}`);
			}
			res.sendStatus(200);
		},
	);

	app.get("/api/log", auth(), (req, res) => {
		res.send(JSON.stringify({ content: logQueue }));
	});

	app.post(
		"/api/song/edit",
		jsonParser,
		auth({ requirePassword: false, allowBearer: true }),
		basicCheckBuilder(["action", "guildId"]),
		checkGuildMiddleware(client),
		async (req: Request, res: Response) => {
			const formatter = misc.prefixFormatter(
				chalk.bgGrey(`(Guild ID: ${req.body.guildId}, IP: ${req.ip})`),
			);
			const cLog = (...data: (string | number)[]) => {
				exp.log(formatter(data.join()));
			};
			const cError = (...data: (string | number)[]) => {
				exp.error(formatter(data.join()));
			};
			const parsed = SongEditRequestSchema.safeParse(req.body);
			if (!parsed.success) {
				cError("Request body error", parsed.error.message);
				return res.sendStatus(400);
			}
			return res.sendStatus(
				await handleSongInterruption(client, parsed.data),
			);
		},
	);

	app.post(
		"/api/action",
		jsonParser,
		auth(),
		basicCheckBuilder(["action"]),
		(req, res) => {
			const formatter = misc.prefixFormatter(
				`${chalk.bgGrey(`(IP: ${req.ip})`)}`,
			);

			exp.log(formatter("Received action request"));
			if (!req.body.action) {
				return res.sendStatus(400);
			}
			switch (req.body.action as ActionType) {
				case ActionType.Exit: {
					globalApp.important(
						formatter("Received exit request, exiting..."),
					);
					process.exit(0);
					break;
				}
				case ActionType.AddAuth: {
					globalApp.important(
						formatter("Creating server-based dashboard"),
					);
					if (!req.body.guildId) {
						globalApp.warn(
							"Failed to create server-based dashboard, missing guild ID",
						);
						return res.sendStatus(400);
					}
					const { token } = client.newToken(req.body.guildId);
					exp.log("Successfully created server-based dashboard");
					res.send(
						JSON.stringify({ token, guildId: req.body.guildId }),
					);
					break;
				}
				case ActionType.ReloadCommands: {
					globalApp.important(formatter("Reloading commands..."));
					event.emitReloadCommands();
					break;
				}
				case ActionType.ReloadSetting: {
					globalApp.important(formatter("Reloading settings..."));
					reloadSetting();
					break;
				}
				default: {
					exp.log(`Action not recognized (${req.body.action})`);
				}
			}
		},
	);

	app.post(
		"/api/search",
		jsonParser,
		auth({ requirePassword: false, allowBearer: true }),
		basicCheckBuilder(["query"]),
		async (req, res) => {
			if (!req.body.query) {
				return res.sendStatus(400);
			}
			exp.log(`Queried ${req.body.query}`);
			const fetched = await search(req.body.query, { limit: 1 }).catch(
				() => null,
			);
			if (!fetched || !fetched[0]) {
				exp.error(`Search failed for query: ${req.body.query}`);
				return res.sendStatus(500);
			}
			const searched = fetched[0];
			exp.log(
				`Returned searched URL: ${searched.url}, title: ${searched.title} and durationInSec: ${searched.durationInSec}`,
			);
			return res.send(
				JSON.stringify({
					url: searched.url,
					title: searched.title,
					durationInSec: searched.durationInSec,
				}),
			);
		},
	);

	app.post(
		"/api/getVideoDetail",
		jsonParser,
		auth({ requirePassword: false, allowBearer: true }),
		basicCheckBuilder(["url"]),
		async (req, res) => {
			if (!req.body.url || !YoutubeVideoRegex.test(req.body.url)) {
				return res.sendStatus(400);
			}
			try {
				if (videoCache.has(req.body.url)) {
					return res.send(
						JSON.stringify(videoCache.get(req.body.url)),
					);
				}
				const video = (await video_info(req.body.url)).video_details;
				videoCache.set(req.body.url, video);
				if (!video) {
					return res.sendStatus(404);
				}
				return res.send(JSON.stringify(video.toJSON()));
			} catch {
				res.sendStatus(500);
			}
		},
	);

	app.post(
		"/api/videoSuggestion",
		jsonParser,
		auth({ requirePassword: false, allowBearer: true }),
		basicCheckBuilder(["query"]),
		async (req, res) => {
			const query = req.body.query ?? null;
			if (!query) {
				return res.sendStatus(400);
			}
			const suggestion = await youtubeSuggest(query, { locale: "zh" });
			return res.send(JSON.stringify({ content: suggestion }));
		},
	);

	app.post(
		"/api/live",
		jsonParser,
		basicCheckBuilder(["guildId"]),
		checkGuildMiddleware(client),
		async (req, res) => {
			exp.log("Live!");
			return res.sendStatus(200);
		},
	);

	app.get(
		"/api/logout",
		auth({ requirePassword: true, allowBearer: true }),
		async (req, res) => {
			exp.log(`${req.ip} just logout`);
			res.sendStatus(200);
		},
	);

	app.get(
		"/api/playingGuildIds",
		auth({ requirePassword: false, allowBearer: true }),
		async (req, res) => {
			const content = await Promise.all(
				Array.from(client.player.keys()).map(async (v) => {
					return {
						id: v,
						name: (await client.guilds.fetch(v)).name ?? null,
					};
				}),
			);
			if (req.headers.authorization?.startsWith("Bearer")) {
				const user = await getUser(
					misc.removeBearer(req.headers.authorization),
				);
				if (!user) {
					return res.sendStatus(401);
				}
				let rawGuilds: Guild[];
				if (userGuildCache.has(user.id)) {
					rawGuilds = userGuildCache.get(user.id) as Guild[];
				} else {
					rawGuilds =
						(await getUserGuilds(
							misc.removeBearer(req.headers.authorization),
						)) ?? [];
					userGuildCache.set(user.id, rawGuilds);
				}
				const guilds = rawGuilds.map((v) => v.id);
				client.appendGuildsByToken(
					misc.removeBearer(req.headers.authorization),
					guilds,
				);
				if (!guilds) {
					return res.sendStatus(401);
				}
				return res.send(
					JSON.stringify({
						content: content.filter((v) => guilds.includes(v.id)),
					}),
				);
			}
			exp.log("Sent guild IDs");
			res.send(JSON.stringify({ content }));
		},
	);

	app.get(
		"/api/guildIds",
		auth({ allowBearer: true, requirePassword: true }),
		async (req, res) => {
			if (!req.headers.authorization) return res.sendStatus(401);
			const guilds = await getUserGuilds(
				misc.removeBearer(req.headers.authorization),
			);
			res.send(JSON.stringify({ content: guilds }));
		},
	);

	app.get("/api/guildIds/all", auth(), async (req, res) => {
		const content = (await client.guilds.fetch()).map((v) => {
			return { id: v.id, name: v.name };
		});
		exp.log("Sent guild IDs");
		res.send(JSON.stringify({ content }));
	});

	app.get("/api/messages/:guildId", auth(), async (req, res) => {
		if (!(await client.guilds.fetch()).has(req.params.guildId)) {
			exp.error("Guild not found");
			return res.sendStatus(404);
		}

		const guild = await client.guilds.fetch(req.params.guildId);
		const channels = await guild.channels.fetch();
		const data = channels.map(async (v) => {
			if (!v) return [];
			const message =
				(await (v as TextChannel).messages?.fetch({ cache: true })) ??
				[];

			const messages: Message[] = message.map((v) => {
				return {
					message: { content: v.content, id: v.id },
					author: { id: v.author.id, tag: v.author.tag },
					timestamp: {
						createdAt: v.createdTimestamp,
						editedAt: v.editedTimestamp ?? undefined,
					},
				};
			});

			return { channel: { id: v.id, name: v.name }, messages };
		});
		return res.send(JSON.stringify({ content: await Promise.all(data) }));
	});

	app.get(
		"/api/song/get/:guildId",
		auth({ requirePassword: false, allowBearer: true }),
		(req, res) => {
			if (
				!checkBearerWithGuild(
					client,
					req.headers.authorization ?? "",
					req.params.guildId,
				)
			) {
				return res.sendStatus(401);
			}
			const data = client.player.get(req.params.guildId)?.getData();
			return res.send(JSON.stringify(data ?? null));
		},
	);

	return app;
}
