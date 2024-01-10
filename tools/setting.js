const { input, confirm } = require('@inquirer/prompts')
const chalk = require('chalk')
const crypto = require('crypto');

(async () => {
    const setting = {
        TOKEN: '',
        TESTING_TOKEN: '',
        CLIENT_ID: '',
        TEST_CLIENT_ID: '',
        AUTH_TOKEN: 'b83688be9b1a88796694310157b24fdc167b10d499dcbd71b953f8dbac441d30',
        PORT: 3000,
        ENABLE_RATE_LIMIT: true
    }

    const token = await input({ message: 'Bot Token' })
    setting.TOKEN = token
    const id = await input({ message: 'Bot ID', validate: v => /[0-9]+/.test(v) })
    setting.CLIENT_ID = id

    if (await confirm({ message: 'Set up development bot?', default: false })) {
        const testToken = await input({ message: 'Development Bot Token' })
        setting.TESTING_TOKEN = testToken
        const testId = await input({ message: 'Development Bot ID', validate: v => /[0-9]+/.test(v) })
        setting.TEST_CLIENT_ID = testId
    }

    if (await confirm({ message: 'Set up custom dashboard authentication password?', default: false })) {
        const pw = await input({ message: 'Password' })
        const hash = crypto.createHash('sha256').update('Basic ' + pw).digest('hex')
        console.log('Your password: ' + chalk.bgGray.whiteBright(pw))
        setting.AUTH_TOKEN = hash
    }
    if (await confirm({ message: 'Set up custom port?', default: false })) {
        const port = parseInt(await input({ message: 'Port', validate: v => /[1-65535]/.test(v) }))
        setting.PORT = port
    }
    if (await confirm({ message: 'Enable rate limit?', default: true })) {
        setting.ENABLE_RATE_LIMIT = true
    }
    if (await confirm({ message: 'Write to setting.json?', default: true })) {
        writeJsonSync(process.cwd() + '/data/setting.json', setting)
        console.log('Done!')
    } else {
        console.log(JSON.stringify(setting, null, 4))
    }
    console.log(chalk.bold('Use ' + chalk.bgGrey.whiteBright('tool/register.js') + ' to register commands'))
})()