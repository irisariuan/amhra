import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";

function parseUrl(url: string, seek?: number) {
    if (seek) {
        return url.includes('?') ? `${url}&t=${seek}` : `${url}?t=${seek}`
    }
    return url
}

export function createYtDlpStream(url: string, seek?: number): PassThrough {
    const stream = spawn('yt-dlp', [
        parseUrl(url, seek),
        '--format', 'bestaudio',
        '-q',
        '--no-playlist',
        '--force-ipv4',
        '-o', '-',
    ], {
        shell: true,
        stdio: ['ignore', 'pipe', 'inherit'],
    })
    const passthrough = new PassThrough()
    stream.stdout.pipe(passthrough)
    return passthrough
}