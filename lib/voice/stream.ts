import moment from "moment";
import { spawn } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import { extractID } from "play-dl";
import { createWriteStream, renameSync, existsSync, createReadStream, readdirSync, writeFileSync } from 'node:fs'
import { readFile, writeFile, stat, unlink } from "node:fs/promises";
import { readSetting } from "../read";
import { dcb } from "../misc";

if (!existsSync(`${process.cwd()}/data/lastUsed.record`)) {
    writeFileSync(`${process.cwd()}/data/lastUsed.record`, '')
}

async function reviewCaches() {
    const maxSize = readSetting().MAX_CACHE_IN_GB * 1024 * 1024 * 1024
    let { size } = await stat(`${process.cwd()}/cache`)
    if (size < maxSize) return
    dcb.log(`Reviewing caches, cache size: ${size} / ${maxSize}`)
    const data = (await readFile(`${process.cwd()}/data/lastUsed.record`, 'utf8')).split('\n')
    const actualCaches = readdirSync(`${process.cwd()}/cache`)
    const deletedFiles = []
    for (const line of data) {
        const [id, lastUsedStr] = line.split('=')
        if (actualCaches.includes(`${id}.music`)) {
            const lastUsed = Number(lastUsedStr)
            if (size >= maxSize && lastUsed < Date.now() - 1000 * 60 * 60 * 24) {
                dcb.log(`Deleting cache: ${id}`)
                const metadata = await stat(`${process.cwd()}/cache/${id}.music`)
                unlink(`${process.cwd()}/cache/${id}.music`).catch(() => { })
                size -= metadata.size
                deletedFiles.push(id)
            }
        } else { deletedFiles.push(id) }
    }
    await updateLastUsed([], deletedFiles).catch(() => { })
}

async function updateLastUsed(updateIds: string[], deleteIds?: string[]) {
    const data = (await readFile(`${process.cwd()}/data/lastUsed.record`, 'utf8')).split('\n');
    (() => {
        for (let i = 0; i < data.length; i++) {
            const line = data[i]
            for (const id of updateIds) {
                if (line.startsWith(id)) {
                    data[i] = `${id}=${Date.now()}`
                    return
                }
            }
        }
        data.push(`${updateIds}=${Date.now()}`)
    })();
    (() => {
        if (!deleteIds) return
        for (let i = 0; i < data.length; i++) {
            const line = data[i]
            for (const id of deleteIds) {
                if (line.startsWith(id)) {
                    data.splice(i, 1)
                    return
                }
            }
        }
    })();
    return await writeFile(`${process.cwd()}/data/lastUsed.record`, data.join('\n'))
}

function parseTime(seek: number) {
    const time = moment(seek)
    const str = seek >= 60 * 60 * 60 ? time.format('HH:mm:ss') : time.format('mm:ss')
    return `*${str}-inf`
}

export function createYtDlpStream(url: string, seek?: number, force = false): Readable {
    const id = extractID(url)
    if (existsSync(`${process.cwd()}/cache/${id}.music`) && !force) {
        updateLastUsed([id])
        dcb.log(`Cache hit: ${id}`)
        return createReadStream(`${process.cwd()}/cache/${id}.music`)
    }
    const stream = spawn('yt-dlp', [
        url,
        '--format', 'bestaudio',
        '-q',
        '--no-playlist',
        '--force-ipv4',
        '--download-sections',
        '--downloader', 'ffmpeg',
        ...(seek ? ['--download-sections', parseTime(seek)] : []),
        '-o', '-',
    ], {
        shell: true,
        stdio: ['ignore', 'pipe', 'inherit'],
    })
    const resultStream = new PassThrough()
    const fileStream = createWriteStream(`${process.cwd()}/cache/${id}.temp.music`)
    stream.stdout.pipe(resultStream)
    stream.stdout.pipe(fileStream)
    fileStream.on('finish', () => {
        renameSync(`${process.cwd()}/cache/${id}.temp.music`, `${process.cwd()}/cache/${id}.music`)
        updateLastUsed([id])
        reviewCaches()
        fileStream.close()
    })
    return resultStream
}