// @ts-check
const express = require('express')
const { rateLimit } = require('express-rate-limit')
const crypto = require('crypto')
const { search } = require('play-dl')
const { event } = require('./event')
const bodyParser = require('body-parser')
const { exp: { log, error }, globalApp } = require('../misc')
const chalk = require('chalk')
const { readJsonSync } = require('../read')
const app = express()

app.use((req, res, next) => {
    event.emit('page', req.path)
    next()
})

const jsonParser = bodyParser.json()
const setting = readJsonSync(process.cwd() + '/data/setting.json')

function registered(req, res, next) {
    if (!req.headers.authorization) {
        error('Auth failed')
        return res.sendStatus(401)
    }

    const auth = Buffer.from(req.headers.authorization, 'utf8')
    const hashed = crypto.createHash('sha256').update(auth).digest('hex')
    if (hashed !== setting.AUTH_TOKEN) {
        error('Auth failed')
        return res.sendStatus(401)
    }

    if (queueNo.has(req.ip)) {
        return next()
    }
    error('Not yet registered')
    res.sendStatus(401)
}

if (setting.ENABLE_RATE_LIMIT) {
    app.use(rateLimit({ windowMs: 5 * 60 * 1000, limit: 5 * 20, standardHeaders: 'draft-7', legacyHeaders: false }))
} else {
    console.log(chalk.yellow('[WARN]') + ' rateLimit disabled')
}

const QUEUE_SIZE = 400

const queue = []
let queueNo = new Map()
event.on('log', (msg, type) => {
    if (type.startsWith('exp')) {
        return
    }
    if (queue.length >= QUEUE_SIZE) {
        queue.splice(0, queue.length - QUEUE_SIZE)
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

app.post('/api/song/edit', jsonParser, registered, (req, res) => {
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

app.post('/api/action', jsonParser, registered, (req, res) => {
    event.emit('globalAction', req.body.action)
    switch (req.body.action) {
        case 'exit':
            globalApp.important('Received exit request')
            process.exit(0)
        default:
            log('Action not recognized')
    }
    log('Received action request')
})

app.post('/api/search', jsonParser, registered, async (req, res) => {
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