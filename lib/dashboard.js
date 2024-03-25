const NodeCache = require("node-cache");
const { readJson } = require("./read");
const ipCache = new NodeCache();
/**
 * 
 * @param {string} guildId Guild Id
 * @param {string} token Token
 * @returns string
 */
async function createLink(guildId, token) {
    const { WEBSITE } = readJson(process.cwd() + '/data/setting.json')
    return encodeURI(`http://${WEBSITE ?? ''}/dashboard/${btoa(JSON.stringify({ guildId, auth: token }))}`)
}
module.exports = { createLink }