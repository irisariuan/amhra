const chalk = require("chalk")

module.exports = {
    exp: {
        log: (...args) => {
            console.log(chalk.magenta('[EXPRESS] ') + args.join())
        }
    },
    dcb: {
        log: (...args) => {
            console.log(chalk.yellowBright('[DISCORD] ') + args.join())
        }
    },
    error: {
        log: (...args) => {
            console.log(chalk.red('[ERROR] ') + args.join())
        }
    }
}