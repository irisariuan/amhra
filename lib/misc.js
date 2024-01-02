const chalk = require("chalk")
const { event, log, error } = require("./express/main")

module.exports = {
    exp: {
        log,
        error
    },
    dcb: {
        log: (...args) => {
            console.log(chalk.blue('[DISCORD] ') + args.join())
            event.emit('log', args.join(), 'dcblog')
        }
    },
    error: {
        err: (...args) => {
            console.log(chalk.red('[ERROR] ') + args.join())
            event.emit('log', args.join(), 'err')
        },
        warn: (...args) => {
            console.log(chalk.yellow('[WARN] ') + args.join())
            event.emit('log', args.join(), 'warn')
        }
    }
}