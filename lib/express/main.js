// @ts-check
const express = require('express')
const { rateLimit } = require('express-rate-limit')
const { search } = require('play-dl')
const { event } = require('./event')
const bodyParser = require('body-parser')
const { exp: { log, error } } = require('../misc')
const chalk = require('chalk')
const app = express()

app.use((req, res, next) => {
    event.emit('page', req.path)
    next()
})
const jsonParser = bodyParser.json()
function registered(req, res, next) {
    if (queueNo.has(req.ip)) {
        return next()
    }
    error('Auth failed')
    res.sendStatus(401)
}

console.log(chalk.yellow('[WARN]') + ' rateLimit disabled')
// app.use(rateLimit({ windowMs: 5 * 60 * 1000, limit: 5 * 20, standardHeaders: 'draft-7', legacyHeaders: false }))

const queue = []
let queueNo = new Map()
event.on('log', (msg, type) => {
    if (type.startsWith('exp')) {
        return
    }
    queue.push({ message: msg, type })
})

app.get('/', (req, res) => {
    res.sendFile(process.cwd() + '/express/main.html')
})
app.get('/css', (req, res) => {
    res.sendFile(process.cwd() + '/express/compiled.css')
})
app.get('/js', (req, res) => {
    res.sendFile(process.cwd() + '/express/main.js')
})

app.get('/api/new', (req, res) => {
    log('New IP registered: ' + req.ip)
    queueNo.set(req.ip, 0)
    res.sendStatus(201)
})

app.get('/api/log', registered, (req, res) => {
    const qn = queueNo.get(req.ip)
    res.send(JSON.stringify({ content: queue.slice(qn) }))
    queueNo.set(req.ip, queue.length)
})

app.post('/api/song/edit', registered, jsonParser, (req, res) => {
    if (req.headers['content-type'] !== 'application/json') {
        return res.sendStatus(412)
    }
    if (req.body.guildId === undefined || req.body.action === undefined) {
        return res.sendStatus(400)
    }

    switch (req.body.action) {
        case 'pause':
            log('Pausing song from dashboard')
            event.emit('songInterruption', req.body.guildId, req.body.action)
            break
        case 'resume':
            log('Resuming song from dashboard')
            event.emit('songInterruption', req.body.guildId, req.body.action)
            break
        case 'setTime':
            if (req.body.detail.sec) {
                log('Setting time')
                event.emit('songInterruption', req.body.guildId, req.body.action, req.body.detail)
            } else {
                error('Request body error')
                return res.sendStatus(400)
            }
            break
        case 'addSong':
            if (req.body.detail.url) {
                log('Received song from dashboard')
                event.emit('songInterruption', req.body.guildId, req.body.action, req.body.detail)
            } else {
                error('URL not found')
                return res.sendStatus(400)
            }
            break
        case 'stop':
            log('Stopping song from dashboard')
            event.emit('songInterruption', req.body.guildId, req.body.action)
            break
            case 'skip':
            log('Skipping song from dashboard')
            event.emit('songInterruption', req.body.guildId, req.body.action)
            break
        default:
            error('Invalid action: ' + req.body.action)
            return res.sendStatus(400)
    }
    return res.sendStatus(200)
})

app.post('/api/search', registered, jsonParser, async (req, res) => {
    if (!req.body.query) {
        return res.sendStatus(400)
    }
    log('Queried ' + req.body.query)
    const s = (await search(req.body.query, { limit: 1 }))[0]
    log(`Returned searched URL: ${s.url}, title: ${s.title} and durationInSec: ${s.durationInSec}`)
    return res.send(JSON.stringify({
        url: s.url,
        title: s.title,
        durationInSec: s.durationInSec
    }))
})

module.exports = { app, registered }