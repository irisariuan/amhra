const { readJsonSync } = require('../read')
const setting = readJsonSync(`${process.cwd()}/data/setting.json`)
const { newUser, getUser, prisma, countUser } = require('../db/core')

/**
 * @param {string} code 
 */
async function exchangeCode(code) {
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
/**
 * 
 * @param {string} refreshCode
 * @returns {Promise<{access_token: string, token_type: string, expires_in: number, refresh_token: string, scope: string} | null>}
 */
async function refreshToken(refreshCode) {
    // todo: perform check in db to see if the token is valid
    if (!countUser(refreshCode) > 0) {
        return null
    }
    try {
        const tokenResponseData = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: setting.CLIENT_ID,
                client_secret: setting.OAUTH_TOKEN,
                refresh_token: refreshCode,
                grant_type: 'refresh_token',
            }).toString(),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        })
        if (!tokenResponseData.ok) {
            return null
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

async function register(code) {
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

/**
 * @param {string} accessToken
 */
async function getUserGuilds(accessToken) {
    let user = await getUser(accessToken)
    if (!user) {
        return null
    }
    const userResult = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: {
            Authorization: `${user.tokenType} ${user.token}`,
        },
    })
    if (!userResult.ok) {
        user = await refreshToken(user.refreshToken)
        return await (await fetch('https://discord.com/api/users/@me/guilds', {
            headers: {
                Authorization: `${user.tokenType} ${user.token}`,
            },
        })).json() ?? null
    }
    return await userResult.json()
}

module.exports = { exchangeCode, register, refreshToken, getUserGuilds }