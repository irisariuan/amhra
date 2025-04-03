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
    rawStream?: Readable,
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

process.on('beforeExit', async (code) => {
    if (code === 64) return
    globalApp.important('Process exiting, closing all streams')
    await closeAllStreams()
    process.exit(64)
})
process.on('SIGINT', async () => {
    await closeAllStreams()
    process.exit(64)
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

export async function prefetch(url: string, seek?: number, force = false) {
    const id = extractID(url)
    const processedUrl = `"https://www.youtube.com/watch?v=${id}"`
    if ((existsSync(`${process.cwd()}/cache/${id}.music`) || streams.has(id)) && !force) {
        dcb.log(`Cache hit: ${id}, skipping prefetch`)
        return
    }

    const args = [
        processedUrl,
        '--format', 'bestaudio',
        '-q',
        '--no-playlist',
        '--force-ipv4',
        ...(seek ? ['--download-sections', parseTime(seek)] : []),
        '-o', '-',
    ]

    dcb.log(`Downloading: ${id} (yt-dlp ${args.join(' ')})`)
    const rawStream = spawn('yt-dlp', args, {
        shell: true,
        stdio: ['ignore', 'pipe', 'inherit'],
    })
    const resultStream = new PassThrough()
    const writeFileStream = createWriteStream(`${process.cwd()}/cache/${id}.temp.music`)
    rawStream.stdout.pipe(resultStream)

    rawStream.stdout.on('data', data => {
        writeFileStream.write(data)
    })
    rawStream.stdout.on('close', () => {
        writeFileStream.end()
    })

    const promise = new Promise<void>((r, err) => {
        rawStream.stdout.on('end', async () => {
            dcb.log(`Download finished: ${id}`)
            streams.delete(id)
            resultStream.end()
        })

        writeFileStream.on('end', async () => {
            await rename(`${process.cwd()}/cache/${id}.temp.music`, `${process.cwd()}/cache/${id}.music`)
            await reviewCaches()
            await updateLastUsed([id])
            r()
        })

        rawStream.on('error', (error) => {
            globalApp.err(`Download error: ${id}`, error)
            streams.delete(id)
            err(error)
        })
    })
    streams.set(id, { readStream: resultStream, writeStream: writeFileStream, promise, rawStream: rawStream.stdout })
}

export async function createYtDlpStream(url: string, seek?: number, force = false): Promise<Readable> {
    const id = extractID(url)
    const fetchedStream = streams.get(id)
    if (fetchedStream) {
        dcb.log(`Stream hit: ${id}`)
        if (fetchedStream.rawStream?.readable) {
            dcb.log(`Stream is readable (raw): ${id}`)
            const passThrough = new PassThrough()
            fetchedStream.rawStream.pipe(passThrough)
            return passThrough
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