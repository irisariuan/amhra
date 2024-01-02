const chalk = require("chalk")
const { event, log, error } = require("./express/main")

module.exports = {
    exp: {
        log,
        error
    },
    dcb: {
        log: (...args) => {
            console.log(chalk.yellowBright('[DISCORD] ') + args.join())
            event.emit('log', args.join(), 'dcblog')
        }
    },
    error: {
        log: (...args) => {
            console.log(chalk.red('[ERROR] ') + args.join())
            event.emit('log', args.join(), 'err')
        }
    }
}