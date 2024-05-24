const { readFile } = require('node:fs/promises')
const { readdirSync } = require('node:fs')

const typeRef = {
    express: 'explog',
    experr: 'error',
    dcblog: 'main',
    dcbmsg: 'message',
    error: 'error',
    warn: 'errwn',
    important: 'important'
}

// LogType = 'dcblog' | 'dcbmsg' | 'explog' | 'experr' | 'error' | 'errim' | 'errwn'

async function loadAll() {
    return (await Promise.all(readdirSync(`${process.cwd()}/data/log`).filter(x => x.endsWith('.log')).map(load))).flat()
}

async function load(filepath) {
    const result = []
    const file = await readFile(`${process.cwd()}/data/log/${filepath}`, 'utf8')
    for (const line of file.split('\n')) {
        if (!line) continue
        const timestamp = Number.parseInt(line?.match(/T[0-9]{13}/)?.at(0).slice(1) ?? 0)
        result.push({
            timestamp,
            type: typeRef[filepath.replace('.log', '')],
            content: line?.match(/T[0-9]{13}: (.*)/)?.at(1) ?? ''
        })
    }
    return result
}

module.exports = {
    load,
    loadAll
}