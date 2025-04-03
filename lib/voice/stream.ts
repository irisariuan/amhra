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

async function closeAllStreams() {
    globalApp.important('Closing all streams')
    for (const [id, stream] of streams) {
        dcb.log(`Killing stream: ${id}`)
        stream.readStream?.destroy()
        stream.writeStream?.destroy()
        if (await existsSync(`${process.cwd()}/cache/${id}.temp.music`)) {
            dcb.log(`Deleting temp file: ${id}`)
            await unlink(`${process.cwd()}/cache/${id}.temp.music`).catch()
        }
        dcb.log(`Stream finished: ${id}`)
    }
    globalApp.important('All streams closed')
}

process.on('beforeExit', closeAllStreams)
process.on('SIGINT', async () => {
    await closeAllStreams()
    process.exit(0)
})

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
                unlink(`${process.cwd()}/cache/${id}.music`).catch()
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
        if (!updateIds.length) return
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
        if (!deleteIds?.length) return
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

export async function prefetch(url: string, seek?: number) {
    const id = extractID(url)
    if (existsSync(`${process.cwd()}/cache/${id}.music`) || streams.has(id)) {
        dcb.log(`Cache hit: ${id}, skipping prefetch`)
        return
    }
    dcb.log(`Downloading: ${id} (${url})`)
    const rawStream = spawn('yt-dlp', [
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

    rawStream.stdout.pipe(resultStream)
    rawStream.stdout.pipe(fileStream)
    
    const errorHandler = async (error: Error) => {
        globalApp.err(`File stream error: ${id}`, error)
        streams.delete(id)

        fileStream.close()
        resultStream.destroy()
        rawStream.kill()

        const temp = await unlink(`${process.cwd()}/cache/${id}.temp.music`).then(() => true).catch(() => false)
        if (temp) dcb.log(`Deleted temp: ${id}`)
        await updateLastUsed([], [id])
    }

    fileStream.once('finish', async () => {
        fileStream.close()
        dcb.log(`Downloaded: ${id}`)
        const { size } = await stat(`${process.cwd()}/cache/${id}.temp.music`)
        if (size === 0) {
            globalApp.warn(`Downloaded file is empty: ${id}, deleting it`)
            await unlink(`${process.cwd()}/cache/${id}.temp.music`).catch()
            return
        }
        await rename(`${process.cwd()}/cache/${id}.temp.music`, `${process.cwd()}/cache/${id}.music`)
        await updateLastUsed([id])
        await reviewCaches()
        streams.delete(id)
        dcb.log(`Stream finished: ${id}`)
    })

    const promise = new Promise<void>((r, err) => {
        const wrappedErrorHandler = (error: Error) => {
            errorHandler(error)
            err(error)
        }
        fileStream.on('error', wrappedErrorHandler)
        resultStream.on('error', wrappedErrorHandler)
        rawStream.on('error', wrappedErrorHandler)
        fileStream.once('finish', r)
    })
    streams.set(id, { readStream: resultStream, writeStream: fileStream, promise })
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
        const promise = new Promise<void>((r, err) => {
            stream.on('end', async () => {
                dcb.log(`Stream ended: ${id}`)
                streams.delete(id)
                r()
                await reviewCaches()
            })
            stream.on('error', (error) => {
                globalApp.err(`Stream error: ${id}`, error)
                streams.delete(id)
                err(error)
            })
        })
        streams.set(id, { readStream: stream, promise })
        if (seek) {
            dcb.log(`Seek requested: ${id}`)
            const ffmpegStream = spawn('ffmpeg', [
                '-i', 'pipe:0',
                '-ss', seek.toString(),
                '-f', 'opus',
                'pipe:1'
            ], {
                shell: true,
                stdio: ['pipe', 'pipe', 'inherit'],
            })
            const resultStream = new PassThrough()
            stream.pipe(ffmpegStream.stdin)
            ffmpegStream.stdout.pipe(resultStream)
            return resultStream
        }
        return stream
    }
    dcb.log(`Cache miss: ${id}, downloading...`)
    await prefetch(url, seek)
    const resultStream = streams.get(id)
    if (!resultStream?.readStream) {
        dcb.log(`Stream not found: ${id}`)
        throw new Error(`Stream not found: ${id}`)
    }
    return resultStream.readStream
}