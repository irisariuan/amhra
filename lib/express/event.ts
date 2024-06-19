const EventEmitter = require('node:events')

export class ExpressEvent extends EventEmitter {}

export const event = new ExpressEvent()