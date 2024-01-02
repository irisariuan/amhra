// @ts-check
const express = require('express')
const { rateLimit } = require('express-rate-limit')
const { ExpressEvent } = require('./event')
const chalk = require('chalk')
const app = express()

const event = new ExpressEvent()
app.use((req, res, next) => {
    event.emit('page', req.path)
    next()
})
app.use(rateLimit({ windowMs: 5 * 60 * 1000, limit: 5 * 20, standardHeaders: 'draft-7', legacyHeaders: false }))

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

app.get('/api/log', (req, res) => {
    if (queueNo.has(req.ip)) {
        const qn = queueNo.get(req.ip)
        res.send(JSON.stringify({ content: queue.slice(qn) }))
        queueNo.set(req.ip, qn + 1)
        return
    }
    return res.sendStatus(401)
})

function log(...args) {
    console.log(chalk.magenta('[EXPRESS] ') + args.join())
    event.emit('log', args.join(), 'explog')
}

function error(...args) {
    console.log(chalk.redBright('[EXPRESS_ERROR] ') + args.join())
    event.emit('log', args.join(), 'experr')
}

module.exports = { app, event, log, error }