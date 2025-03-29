import { readSetting } from '../read'
const setting = readSetting()
import { newUser, getUser, hasUser } from '../db/core'
import NodeCache from 'node-cache';
import { client } from '../client';
import { misc } from '../misc';

export interface User {
	id: string;
	createdAt: Date;
	updatedAt: Date;
	token: string;
	tokenType: string;
	refreshToken: string;
	accessToken: string;
	refreshTokenExpiresAt: number;
}

export interface Guild {
	id: string,
	name: string
}

const userGuildCache = new NodeCache({ stdTTL: 60 * 3 })

export async function exchangeCode(code: string) {
	try {
		const tokenResponseData = await fetch('https://discord.com/api/oauth2/token', {
			method: 'POST',
			body: new URLSearchParams({
				client_id: setting.CLIENT_ID,
				client_secret: setting.OAUTH_TOKEN,
				code,
				grant_type: 'authorization_code',
				redirect_uri: setting.REDIRECT_URI,
			}).toString(),
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
		})
		if (!tokenResponseData.ok) {
			return null
		}
		const oauthData = await tokenResponseData?.json()
		return oauthData
	} catch (error) {
		// NOTE: An unauthorized token will not throw an error
		// tokenResponseData.statusCode will be 401
		console.error(error)
	}
}

export async function refreshToken(user: Pick<User, 'accessToken' | 'refreshToken' | 'refreshTokenExpiresAt'>): Promise<User | undefined> {
	if (!hasUser(user.accessToken) || user.refreshTokenExpiresAt < Date.now()) {
		return
	}
	try {
		const tokenResponseData = await fetch('https://discord.com/api/oauth2/token', {
			method: 'POST',
			body: new URLSearchParams({
				client_id: setting.CLIENT_ID,
				client_secret: setting.OAUTH_TOKEN,
				refresh_token: user.refreshToken,
				grant_type: 'refresh_token',
			}).toString(),
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
		})
		if (!tokenResponseData.ok) {
			return
		}
		/**
		 * Access token response example
		 * {
			"access_token": "TOKEN",
			"token_type": "Bearer",
			"expires_in": 604800,
			"refresh_token": "TOKEN",
			"scope": "identify"
			}
		 */
		const oauthData = await tokenResponseData?.json()
		return await newUser(oauthData.id, oauthData.access_token, oauthData.token_type, oauthData.refresh_token, oauthData.expires_in)
	} catch (error) {
		// NOTE: An unauthorized token will not throw an error
		// tokenResponseData.statusCode will be 401
		console.error(error)
	}
}

export async function register(code: string): Promise<User | null> {
	const oauthData = await exchangeCode(code)
	if (!oauthData) {
		return null
	}

	const userResult = await (await fetch('https://discord.com/api/users/@me', {
		headers: {
			Authorization: `${oauthData.token_type} ${oauthData.access_token}`,
		},
	})).json()
	if (!userResult || userResult.bot || !userResult.id) {
		return null
	}

	return await newUser(userResult.id, oauthData.access_token, oauthData.token_type, oauthData.refresh_token, oauthData.expires_in)
}

export async function getUserGuilds(accessToken: string): Promise<Guild[] | null> {
	const user = await getUser(accessToken)
	if (!user) {
		return null
	}
	const userResult = await fetch('https://discord.com/api/users/@me/guilds', {
		headers: {
			Authorization: `${user.tokenType} ${user.token}`,
		},
	})
	if (!userResult.ok) {
		const refreshedUser = await refreshToken(user)
		if (!refreshedUser) {
			return null
		}
		return await (await fetch('https://discord.com/api/users/@me/guilds', {
			headers: {
				Authorization: `${refreshedUser.tokenType} ${refreshedUser.token}`,
			},
		})).json() ?? null
	}
	return await userResult.json()
}

export function getAllGuilds() {
	return Promise.all(Array.from(client.player.keys()).map(async v => { return { id: v, name: (await client.guilds.fetch(v)).name ?? null } }))
}

export async function getUserGuild(user: User, auth: string) {
	const allGuilds = await getAllGuilds()
	let rawGuilds: Guild[] | undefined = userGuildCache.get(user.id)
	if (rawGuilds === undefined) {
		rawGuilds = await getUserGuilds(misc.removeBearer(auth)) ?? []
		userGuildCache.set(user.id, rawGuilds)
	}
	const guilds = rawGuilds.map(v => v.id)
	client.appendGuildsByToken(auth, guilds)
	return allGuilds.filter(v => guilds.includes(v.id))
}