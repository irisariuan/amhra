import moment from "moment";
import { spawn } from "node:child_process";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { extractID } from "play-dl";
import { createWriteStream, existsSync, createReadStream, readdirSync, writeFileSync } from 'node:fs'
import { readFile, writeFile, stat, unlink, rename } from "node:fs/promises";
import { readSetting } from "../read";
import { dcb, globalApp } from "../misc";

if (!existsSync(`${process.cwd()}/data/lastUsed.record`)) {
    writeFileSync(`${process.cwd()}/data/lastUsed.record`, '')
}

interface YtDlpStream {
    writeStream?: Writable,
    rawStream?: Readable,
    promise: Promise<void>,
    data: (string | Buffer)[],
}

const streams = new Map<string, YtDlpStream>()

async function closeAllStreams() {
    globalApp.important('Closing all streams')
    for (const [id, stream] of streams) {
        dcb.log(`Killing stream: ${id}`)
        stream.rawStream?.destroy()
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
    const spawnedProcess = spawn('yt-dlp', args, {
        shell: true,
        stdio: ['ignore', 'pipe', 'inherit'],
    })
    const rawOutputStream = spawnedProcess.stdout
    const writeStream = createWriteStream(`${process.cwd()}/cache/${id}.temp.music`)
    const data: (string | Buffer)[] = []
    rawOutputStream.pipe(writeStream)

    writeStream.on('finish', async () => {
        dcb.log(`Download completed: ${id}`)
        writeStream.close()
        streams.delete(id)
        await rename(`${process.cwd()}/cache/${id}.temp.music`, `${process.cwd()}/cache/${id}.music`)
        await updateLastUsed([id])
        await reviewCaches()
    })

    writeStream.on('error', async (error) => {
        globalApp.err(`Write error: ${id}`, error)
        await unlink(`${process.cwd()}/cache/${id}.temp.music`).catch()
        await updateLastUsed([], [id])
        await reviewCaches()
    })

    rawOutputStream.on('error', (error) => {
        globalApp.err(`Download error: ${id}`, error)
        writeStream.destroy(new Error('Download error'))
        streams.delete(id)
    })

    rawOutputStream.on('data', chunk => {
        data.push(chunk)
    })

    streams.set(id, {
        rawStream: rawOutputStream,
        promise: new Promise<void>((r, e) => {
            rawOutputStream.on('end', async () => {
                dcb.log(`Stream ended: ${id}`)
                streams.delete(id)
                r()
            })
            rawOutputStream.on('error', (error) => {
                globalApp.err(`Stream error: ${id}`, error)
                streams.delete(id)
                e(error)
            })
        }),
        data
    })
}

export async function createYtDlpStream(url: string, seek?: number, force = false): Promise<Readable> {
    const id = extractID(url)
    const fetchedStream = streams.get(id)
    if (fetchedStream) {
        dcb.log(`Stream hit: ${id}`)
        const passThrough = new PassThrough()
        for (const chunk of fetchedStream.data) {
            passThrough.write(chunk)
        }
        if (fetchedStream.rawStream?.readable) {
            fetchedStream.rawStream.pipe(passThrough)
            return passThrough
        }
        passThrough.end()
        return passThrough
    }
    if (existsSync(`${process.cwd()}/cache/${id}.music`) && !force) {
        dcb.log(`Cache hit: ${id}`)
        await updateLastUsed([id])
        const stream = createReadStream(`${process.cwd()}/cache/${id}.music`)
        dcb.log(`Stream created: ${id}`)
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
    await prefetch(url, seek, force)
    const resultStream = streams.get(id)
    if (!resultStream?.rawStream?.readable) {
        dcb.log(`Stream not found/ not readable: ${id}`)
        throw new Error(`Stream not found/ not readable: ${id}`)
    }
    const passThrough = new PassThrough()
    resultStream.rawStream.pipe(passThrough)
    return passThrough
}