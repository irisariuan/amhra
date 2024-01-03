const chalk = require("chalk")
const { event } = require('./express/event')

module.exports = {
    exp: {
        log: (...args) => {
            console.log(chalk.magenta('[EXPRESS] ') + args.join())
            event.emit('log', args.join(), 'explog')
        },
        error: (...args) => {
            console.log(chalk.redBright('[EXPRESS_ERROR] ') + args.join())
            event.emit('log', args.join(), 'experr')
        }
    },
    dcb: {
        log: (...args) => {
            console.log(chalk.blue('[DISCORD] ') + args.join())
            event.emit('log', args.join(), 'dcblog')
        }
    },
    globalApp: {
        err: (...args) => {
            console.log(chalk.red('[ERROR] ') + args.join())
            event.emit('log', args.join(), 'err')
        },
        warn: (...args) => {
            console.log(chalk.yellow('[WARN] ') + args.join())
            event.emit('log', args.join(), 'warn')
        },
        important: (...args) => {
            console.log(chalk.bgYellowBright.whiteBright.bold('[IMPORTANT]') + ' ' + args.join())
            event.emit('log', args.join(), 'warn')
        }
    }
}