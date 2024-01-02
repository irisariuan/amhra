//@ts-check

const EventEmitter = require('node:events')

class ExpressEvent extends EventEmitter {}

const event = new ExpressEvent()

module.exports = {
    ExpressEvent, event
}