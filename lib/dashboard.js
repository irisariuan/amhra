const { readFileSync } = require('fs')

/**
 * 
 * @param {string} guildId Guild Id
 * @param {string} token Token
 * @returns string
 */
async function createLink(guildId, token) {
    const { WEBSITE } = JSON.parse(readFileSync(process.cwd() + '/data/setting.json', 'utf8'))
    return encodeURI(`http://${WEBSITE ?? 'null'}/dashboard/${btoa(JSON.stringify({ guildId, auth: token }))}`)
}
module.exports = { createLink }