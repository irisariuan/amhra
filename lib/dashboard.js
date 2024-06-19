const { readFileSync } = require('node:fs')
const NodeCache = require("node-cache")
const { readJsonSync } = require('./read')
const ipCache = new NodeCache()

const setting = readJsonSync()
/**
 * 
 * @param {string} guildId Guild Id
 * @param {string} token Token
 * @returns string
 */
async function createLink(guildId, token) {
    const prefix = setting.HTTPS ? 'https' : 'http'
    if (setting.WEBSITE) {
        return encodeURI(`${prefix}://${setting.WEBSITE}/dashboard/${btoa(JSON.stringify({ guildId, auth: token }))}`)
    }

    const cache = ipCache.get('ip')
    if (cache) {
        return encodeURI(`${prefix}://${cache}:3000/dashboard/${btoa(JSON.stringify({ guildId, auth: token }))}`)
    }
    const { ip } = await (await fetch('https://api.ipify.org/?format=json')).json()
    ipCache.set('ip', ip)
}
module.exports = { createLink }