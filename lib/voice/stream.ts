import moment from "moment";
import { spawn } from "node:child_process";
import { PassThrough, type Writable, type Readable } from "node:stream";
import { extractID } from "play-dl";
import { createWriteStream, renameSync, existsSync, createReadStream, readdirSync, writeFileSync } from 'node:fs'
import { readFile, writeFile, stat, unlink, rename } from "node:fs/promises";
import { readSetting } from "../read";
import { dcb, globalApp } from "../misc";

if (!existsSync(`${process.cwd()}/data/lastUsed.record`)) {
    writeFileSync(`${process.cwd()}/data/lastUsed.record`, '')
}

interface YtDlpStream {
    readStream?: Readable,
    writeStream?: Writable,
    promise: Promise<void>,
}

const streams = new Map<string, YtDlpStream>()

async function reviewCaches(forceReview = false) {
    const maxSize = readSetting().MAX_CACHE_IN_GB * 1024 * 1024 * 1024
    let { size } = await stat(`${process.cwd()}/cache`)
    if (size < maxSize && !forceReview) return
    dcb.log(`Reviewing caches, cache size: ${size} / ${maxSize}`)
    const data = (await readFile(`${process.cwd()}/data/lastUsed.record`, 'utf8')).split('\n')
    const actualCaches = readdirSync(`${process.cwd()}/cache`)
    const deletedFiles = []
    for (const line of data) {
        const [id, lastUsedStr] = line.split('=')
        const lastUsed = Number(lastUsedStr)
        if (actualCaches.includes(`${id}.music`)) {
            const metadata = await stat(`${process.cwd()}/cache/${id}.music`)
            if (metadata.size === 0 || size >= maxSize && !forceReview && lastUsed < Date.now() - 1000 * 60 * 60 * 24) {
                dcb.log(`Deleting cache: ${id}`)
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

export async function createYtDlpStream(url: string, seek?: number, force = false): Promise<Readable> {
    const id = extractID(url)
    const fetchedStream = streams.get(id)
    if (fetchedStream) {
        dcb.log(`Stream hit: ${id}`)
        if (fetchedStream.readStream?.readable) {
            dcb.log(`Stream is readable: ${id}`)
            return fetchedStream.readStream
        }
        dcb.log(`Stream is not readable: ${id}`)
        await fetchedStream.promise
        dcb.log(`Stream finished: ${id}`)
    }
    if (existsSync(`${process.cwd()}/cache/${id}.music`) && !force) {
        dcb.log(`Cache hit: ${id}`)
        updateLastUsed([id])
        const stream = createReadStream(`${process.cwd()}/cache/${id}.music`)
        dcb.log(`Stream created: ${id}`)
        const promise = new Promise<void>(r => stream.on('end', async () => {
            dcb.log(`Stream ended: ${id}`)
            streams.delete(id)
            r()
            await reviewCaches()
        }))
        streams.set(id, { readStream: stream, promise })
        return stream
    }
    const stream = spawn('yt-dlp', [
        url,
        '--format', 'bestaudio',
        '-q',
        '--no-playlist',
        '--force-ipv4',
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
    const promise = new Promise<void>(r => fileStream.once('finish', async () => {
        fileStream.close()
        dcb.log(`Downloaded: ${id}`)
        const { size } = await stat(`${process.cwd()}/cache/${id}.temp.music`)
        if (size === 0) {
            globalApp.warn(`Downloaded file is empty: ${id}, deleting it`)
            await unlink(`${process.cwd()}/cache/${id}.temp.music`).catch(() => { })
            return
        }
        await rename(`${process.cwd()}/cache/${id}.temp.music`, `${process.cwd()}/cache/${id}.music`)
        await updateLastUsed([id])
        await reviewCaches()
        streams.delete(id)
        dcb.log(`Stream finished: ${id}`)
        r()
    }))
    streams.set(id, { readStream: resultStream, writeStream: fileStream, promise })
    return resultStream
}