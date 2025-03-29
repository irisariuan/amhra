import { createYtDlpStream } from '../lib/voice/stream'
createYtDlpStream('https://www.youtube.com/watch?v=nK9WuY-v7o0').on('data', (data) => {
    console.log(data)
})