import { readFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'

export enum TypeRef {
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
    return (await Promise.all(readdirSync(`${process.cwd()}/data/log`).filter(x => x.endsWith('.log')).map(v => load(v)))).flat()
}

export async function load(...filepaths: string[]) {
    const result: Log[] = []
    for (const filepath of filepaths) {
        const file = await readFile(`${process.cwd()}/data/log/${filepath}.log`, 'utf8')
        for (const line of file.split('\n')) {
            if (!line) continue
            const timestamp = Number.parseInt(line?.match(/T[0-9]{13}/)?.at(0)?.slice(1) ?? '0')
            result.push({
                time: timestamp,
                type: filepath.replace('.log', '') as LogType,
                message: line?.match(/T[0-9]{13}: (.*)/)?.at(1) ?? ''
            })
        }
    }
    return result
}