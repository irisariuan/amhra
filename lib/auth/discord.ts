import NodeCache from "node-cache";
import { client } from "../client";
import { prisma } from "../db/core";
import { createWebAccount } from "../db/account";
import { requireSecret } from "../secrets";
import { readSetting } from "../setting";
import type { Account } from "@prisma/client";

const setting = readSetting();
const userGuildCache = new NodeCache({ stdTTL: 60 * 3 });

export interface Guild {
	id: string;
	name: string;
}

interface DiscordOAuthData {
	access_token: string;
	token_type: string;
	refresh_token: string;
	expires_in: number;
}

async function exchangeCode(code: string): Promise<DiscordOAuthData | null> {
	try {
		const res = await fetch("https://discord.com/api/oauth2/token", {
			method: "POST",
			body: new URLSearchParams({
				client_id: setting.CLIENT_ID,
				client_secret: requireSecret("OAUTH_TOKEN"),
				code,
				grant_type: "authorization_code",
				redirect_uri: setting.REDIRECT_URI,
			}).toString(),
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

async function fetchDiscordUser(
	oauth: DiscordOAuthData,
): Promise<{ id: string; username?: string; bot?: boolean } | null> {
	const res = await fetch("https://discord.com/api/users/@me", {
		headers: { Authorization: `${oauth.token_type} ${oauth.access_token}` },
	});
	if (!res.ok) return null;
	return res.json();
}

/**
 * Completes a Discord OAuth code exchange and resolves it to an account.
 * If the Discord identity is already linked, that account is returned; if
 * `linkTo` is provided (an authenticated web account), the identity is attached
 * to it; otherwise a fresh web account is created and linked. Returns null on
 * any failure or if a bot account is presented.
 */
export async function resolveDiscordLogin(
	code: string,
	linkTo?: string,
): Promise<Account | null> {
	const oauth = await exchangeCode(code);
	if (!oauth) return null;
	const discordUser = await fetchDiscordUser(oauth);
	if (!discordUser || discordUser.bot || !discordUser.id) return null;

	const existing = await prisma.discordIdentity.findUnique({
		where: { discordId: discordUser.id },
		include: { account: true },
	});

	const identityData = {
		username: discordUser.username,
		token: oauth.access_token,
		tokenType: oauth.token_type,
		refreshToken: oauth.refresh_token,
		accessTokenExpiresAt: BigInt(Date.now() + oauth.expires_in * 1000),
	};

	// Already linked: refresh stored tokens and log into that account.
	if (existing) {
		await prisma.discordIdentity.update({
			where: { discordId: discordUser.id },
			data: identityData,
		});
		return existing.account;
	}

	const accountId = linkTo ?? (await createWebAccount(discordUser.username)).id;
	await prisma.discordIdentity.create({
		data: { discordId: discordUser.id, accountId, ...identityData },
	});
	return prisma.account.findUnique({ where: { id: accountId } });
}

export async function unlinkDiscord(accountId: string): Promise<void> {
	await prisma.discordIdentity
		.delete({ where: { accountId } })
		.catch(() => {});
}

async function refreshDiscordToken(
	discordId: string,
): Promise<string | null> {
	const identity = await prisma.discordIdentity.findUnique({
		where: { discordId },
	});
	if (!identity) return null;
	const res = await fetch("https://discord.com/api/oauth2/token", {
		method: "POST",
		body: new URLSearchParams({
			client_id: setting.CLIENT_ID,
			client_secret: requireSecret("OAUTH_TOKEN"),
			refresh_token: identity.refreshToken,
			grant_type: "refresh_token",
		}).toString(),
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
	});
	if (!res.ok) return null;
	const oauth: DiscordOAuthData = await res.json();
	await prisma.discordIdentity.update({
		where: { discordId },
		data: {
			token: oauth.access_token,
			tokenType: oauth.token_type,
			refreshToken: oauth.refresh_token,
			accessTokenExpiresAt: BigInt(Date.now() + oauth.expires_in * 1000),
		},
	});
	return oauth.access_token;
}

/** The Discord guilds the linked user belongs to (cached briefly). */
export async function getLinkedUserGuilds(
	accountId: string,
): Promise<Guild[] | null> {
	const identity = await prisma.discordIdentity.findUnique({
		where: { accountId },
	});
	if (!identity) return null;

	const cached = userGuildCache.get<Guild[]>(identity.discordId);
	if (cached) return cached;

	let token = identity.token;
	let res = await fetch("https://discord.com/api/users/@me/guilds", {
		headers: { Authorization: `${identity.tokenType} ${token}` },
	});
	if (!res.ok) {
		const refreshed = await refreshDiscordToken(identity.discordId);
		if (!refreshed) return null;
		token = refreshed;
		res = await fetch("https://discord.com/api/users/@me/guilds", {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!res.ok) return null;
	}
	const guilds: Guild[] = (await res.json()) ?? [];
	userGuildCache.set(identity.discordId, guilds);
	return guilds;
}

export function getAllPlayingGuilds() {
	return Promise.all(
		Array.from(client.player.keys()).map(async v => ({
			id: v,
			name: (await client.guilds.fetch(v)).name ?? null,
		})),
	);
}

/** Playing guilds visible to a Discord-linked account (intersection). */
export async function getPlayingGuildsForAccount(
	accountId: string,
): Promise<{ id: string; name: string | null }[]> {
	const playing = await getAllPlayingGuilds();
	const userGuilds = await getLinkedUserGuilds(accountId);
	if (!userGuilds) return [];
	const ids = new Set(userGuilds.map(g => g.id));
	return playing.filter(g => ids.has(g.id));
}
