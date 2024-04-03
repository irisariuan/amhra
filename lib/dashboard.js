const { readFileSync } = require('node:fs')
const NodeCache = require("node-cache")
const ipCache = new NodeCache()

const { WEBSITE, HTTPS } = JSON.parse(readFileSync(`${process.cwd()}/data/setting.json`, 'utf8'))
/**
 * 
 * @param {string} guildId Guild Id
 * @param {string} token Token
 * @returns string
 */
async function createLink(guildId, token) {
    const prefix = HTTPS ? 'https' : 'http'
    if (WEBSITE) {
        return encodeURI(`${prefix}://${WEBSITE}/dashboard/${btoa(JSON.stringify({ guildId, auth: token }))}`)
    }

    const cache = ipCache.get('ip')
    if (cache) {
        return encodeURI(`${prefix}://${cache}:3000/dashboard/${btoa(JSON.stringify({ guildId, auth: token }))}`)
    }
    const { ip } = await (await fetch('https://api.ipify.org/?format=json')).json()
    ipCache.set('ip', ip)
}
module.exports = { createLink }