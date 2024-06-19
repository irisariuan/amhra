import NodeCache from "node-cache"
import { readJsonSync } from './read'
const ipCache = new NodeCache()

const setting = readJsonSync()

export async function createLink(guildId: string, token: string) {
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
    return encodeURI(`${prefix}://${ip}:3000/dashboard/${btoa(JSON.stringify({ guildId, auth: token }))}`)
}