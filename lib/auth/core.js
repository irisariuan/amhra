const { readJsonSync } = require('../read')
const setting = readJsonSync(`${process.cwd()}/data/setting.json`)


/**
 * 
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
 * @param {string} code 
 */
async function refreshToken(code) {
    // todo: perform check in db to see if the token is valid
    try {
        const tokenResponseData = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: setting.CLIENT_ID,
                client_secret: setting.OAUTH_TOKEN,
                refresh_token: code,
                grant_type: 'refresh_token',
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

async function register(code) {
    const oauthData = await exchangeCode(code)
    if (!oauthData) {
        return null
    }
    const userResult = await fetch('https://discord.com/api/users/@me', {
        headers: {
            authorization: `${oauthData.token_type} ${oauthData.access_token}`,
        },
    })
}

module.exports = { exchangeCode, register }