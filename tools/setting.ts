import { confirm, input } from "@inquirer/prompts";
import chalk from "chalk";
import crypto from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import type { LogFile, Setting } from "../lib/setting";
import { writeJsonSync } from "../lib/setting";

(async () => {
	const setting: Setting = {
		TOKEN: "",
		TESTING_TOKEN: "",
		CLIENT_ID: "",
		TEST_CLIENT_ID: "",
		AUTH_TOKEN:
			"b83688be9b1a88796694310157b24fdc167b10d499dcbd71b953f8dbac441d30",
		PORT: 3000,
		RATE_LIMIT: 0,
		DETAIL_LOGGING: false,
		QUEUE_SIZE: 0,
		WEBSITE: null,
		HTTPS: false,
		OAUTH_TOKEN: "",
		PREFIX: "!",
		PRELOAD: [],
		REDIRECT_URI: "",
		SEEK: true,
		USE_YOUTUBE_DL: false,
		VOLUME_MODIFIER: 1,
		AUTO_LEAVE: 15 * 60 * 1000,
		USE_COOKIES: false,
		BANNED_IDS: [],
		MAX_CACHE_IN_GB: 1,
		MESSAGE_LOGGING: false,
		VOICE_LOGGING: false,
	};

	const token = await input({ message: "Bot Token" });
	setting.TOKEN = token;
	const id = await input({
		message: "Bot ID",
		validate: (v) => /[0-9]+/.test(v),
	});
	setting.CLIENT_ID = id;

	if (await confirm({ message: "Set up development bot?", default: false })) {
		const testToken = await input({ message: "Development Bot Token" });
		setting.TESTING_TOKEN = testToken;
		const testId = await input({
			message: "Development Bot ID",
			validate: (v) => /[0-9]+/.test(v),
		});
		setting.TEST_CLIENT_ID = testId;
	}

	if (
		await confirm({
			message: "Set up custom dashboard authentication password?",
			default: true,
		})
	) {
		const pw = await input({ message: "Password" });
		const hash = crypto
			.createHash("sha256")
			.update(`Basic ${pw}`)
			.digest("hex");
		console.log(`Your password: ${chalk.bgGray.whiteBright(pw)}`);
		setting.AUTH_TOKEN = hash;
	}
	if (await confirm({ message: "Set up custom port?", default: false })) {
		const port = Number.parseInt(
			await input({
				message: "Port",
				validate: (v) => /[1-65535]/.test(v),
			}),
		);
		setting.PORT = port;
	}
	if (await confirm({ message: "Enable rate limit?", default: true })) {
		const rateLimit = await input({
			message: "Rate limit (per 15 minute)",
			validate: (v) => Number.parseInt(v) > 0,
		});
		setting.RATE_LIMIT = Number.parseInt(rateLimit);
	}
	if (
		await confirm({
			message: "Will your bot use detailed logging?",
			default: false,
		})
	) {
		setting.DETAIL_LOGGING = true;
	}
	if (
		await confirm({
			message: "Do you have a custom website?",
			default: false,
		})
	) {
		const website = await input({
			message: "Website URL",
			validate: (v) =>
				/[a-zA-Z0-9]+\.[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)?/.test(v),
		});
		setting.WEBSITE = website;
		if (
			await confirm({
				message: "Would you use HTTPS over HTTP?",
				default: true,
			})
		) {
			setting.HTTPS = true;
		}
	}
	const maxCacheSize = await input({
		message: "Set up your maximum cache size in GB",
		validate: (v) => !Number.isNaN(Number(v)) && Number(v) > 0,
		default: "1",
	});
	setting.MAX_CACHE_IN_GB = Number(maxCacheSize);
	if (
		await confirm({
			message: "Would you like to limit logs cache size?",
			default: false,
		})
	) {
		setting.QUEUE_SIZE = Number(
			await input({
				message: "Set up your cache size for logs",
				validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
				default: "4000",
			}),
		);
	}
	setting.USE_YOUTUBE_DL = await confirm({
		message: "Would you like to use youtube-dl?",
		default: true,
	});
	setting.MESSAGE_LOGGING = await confirm({
		message: "Would you like to log messages?",
		default: false,
	});
	setting.VOICE_LOGGING = await confirm({
		message: "Would you like to log voice states?",
		default: false,
	});
	setting.SEEK = await confirm({
		message: "Would you like to enable audio seeking?",
		default: true,
	});
	setting.VOLUME_MODIFIER = Number(
		await input({
			message: "Set up your volume modifier",
			validate: (v) => !Number.isNaN(Number(v)) && Number(v) > 0,
			default: "1",
		}),
	);
	setting.AUTO_LEAVE =
		Number(
			await input({
				message: "Set up your auto leave time in minutes",
				validate: (v) => !Number.isNaN(Number(v)) && Number(v) > 0,
				default: "15",
			}),
		) *
		60 *
		1000;
	setting.PREFIX = await input({
		message: "Set up your command prefix",
		default: "!",
		validate: (v) => v.length > 0,
	});
	setting.REDIRECT_URI = await input({
		message: "Set up your redirect URI",
		default: "http://localhost:3000/callback",
		validate: (v) =>
			/^https?:\/\/[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*(:\d+)?(\/.*)?$/.test(
				v,
			),
	});
	setting.PRELOAD = (
		await input({
			message: "Set up your preload log files (comma separated)",
			default: "errim,error,errwn,express,main,message",
			validate: (value) =>
				[
					"errim",
					"error",
					"errwn",
					"express",
					"main",
					"message",
				].includes(value),
		})
	)
		.split(",")
		.map((v) => v.trim())
		.filter((v) => v.length > 0) as LogFile[];

	if (await confirm({ message: "Write to setting.json?", default: true })) {
		writeJsonSync(`${process.cwd()}/data/setting.json`, setting);
		console.log("Done!");
	} else {
		console.log(JSON.stringify(setting, null, 4));
	}

	if (!existsSync(`${process.cwd()}/data/cookies.json`)) {
		writeFileSync(`${process.cwd()}/data/cookies.json`, '{"cookies": []}');
		if (
			await confirm({
				message: "Would you like to use cookies?",
				default: false,
			})
		) {
			setting.USE_COOKIES = true;
		}
		console.log(
			"Created cookies.json, please fill it with your cookies if you want to use cookies",
		);
	}

	console.log(
		chalk.bold(
			`Use ${chalk.bgGrey.whiteBright("tool/register.ts")} to register commands`,
		),
	);
})();
