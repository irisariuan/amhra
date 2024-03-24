const NodeCache = require("node-cache");
const ipCache = new NodeCache();
/**
 * 
 * @param {string} guildId Guild Id
 * @param {string} token Token
 * @returns string
 */
async function createLink(guildId, token) {
    const cache = ipCache.get('ip')
    if (cache) {
        return encodeURI(`http://${cache}:3000/dashboard/${btoa(JSON.stringify({ guildId, auth: token }))}`)
    }
    const { ip } = await (await fetch('https://api.ipify.org/?format=json')).json()
    ipCache.set('ip', ip)
    return encodeURI(`http://${ip}:3000/dashboard/${btoa(JSON.stringify({ guildId, auth: token }))}`)
}
module.exports = { createLink }