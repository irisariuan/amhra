import { readFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'

export enum typeRef {
    main = 'dcblog',
    message = 'dcbmsg',
    express = 'explog',
    error = 'error',
    errwn = 'warn',
    errim = 'important'
}
export type LogType = 'dcblog' | 'dcbmsg' | 'explog' | 'experr' | 'error' | 'errim' | 'errwn'
export interface Log {
    time: number
    type: LogType
    message: string
}

export async function loadAll() {
    return (await Promise.all(readdirSync(`${process.cwd()}/data/log`).filter(x => x.endsWith('.log')).map(load))).flat()
}

export async function load(...filepaths) {
    const result: Log[] = []
    for (const filepath of filepaths) {
        const file = await readFile(`${process.cwd()}/data/log/${filepath}`, 'utf8')
        for (const line of file.split('\n')) {
            if (!line) continue
            const timestamp = Number.parseInt(line?.match(/T[0-9]{13}/)?.at(0)?.slice(1) ?? '0')
            result.push({
                time: timestamp,
                type: typeRef[filepath.replace('.log', '')],
                message: line?.match(/T[0-9]{13}: (.*)/)?.at(1) ?? ''
            })
        }
    }
    return result
}