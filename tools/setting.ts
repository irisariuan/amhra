import { input, confirm } from '@inquirer/prompts'
import chalk from 'chalk'
import crypto from 'node:crypto'
import { writeJsonSync } from '../lib/read';
import type { Setting } from '../lib/setting';

(async () => {
    const setting: Setting = {
        TOKEN: '',
        TESTING_TOKEN: '',
        CLIENT_ID: '',
        TEST_CLIENT_ID: '',
        AUTH_TOKEN: 'b83688be9b1a88796694310157b24fdc167b10d499dcbd71b953f8dbac441d30',
        PORT: 3000,
        RATE_LIMIT: 0,
        DETAIL_LOGGING: false,
        QUEUE_SIZE: 4000,
        WEBSITE: null,
        HTTPS: false,
        OAUTH_TOKEN: '',
        PREFIX: '!',
        PRELOAD: [],
        REDIRECT_URI: '',
        SEEK: true,
        USE_YOUTUBE_DL: false,
        VOLUME_MODIFIER: 1,
        AUTO_LEAVE: 15 * 60 * 1000
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
        const hash = crypto.createHash('sha256').update(`Basic ${pw}`).digest('hex')
        console.log(`Your password: ${chalk.bgGray.whiteBright(pw)}`)
        setting.AUTH_TOKEN = hash
    }
    if (await confirm({ message: 'Set up custom port?', default: false })) {
        const port = Number.parseInt(await input({ message: 'Port', validate: v => /[1-65535]/.test(v) }))
        setting.PORT = port
    }
    if (await confirm({ message: 'Enable rate limit?', default: true })) {
        const rateLimit = await input({ message: 'Rate limit (per 15 minute)', validate: v => Number.parseInt(v) > 0 })
        setting.RATE_LIMIT = Number.parseInt(rateLimit)
    }
    if (await confirm({ message: 'Will your bot use detailed logging?', default: false })) {
        setting.DETAIL_LOGGING = true
    }
    if (await confirm({ message: 'Do you have a custom website?', default: false })) {
        const website = await input({ message: 'Website URL', validate: v => /[a-zA-Z0-9]+\.[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)?/.test(v) })
        setting.WEBSITE = website
        if (await confirm({ message: 'Would you use HTTPS over HTTP?', default: false })) {
            setting.HTTPS = true
        }
    }
    const queueSize = await input({ message: 'Set up your cache size for logs', validate: v => Number.parseInt(v) > 0, default: '4000' })
    setting.QUEUE_SIZE = Number.parseInt(queueSize)
    if (await confirm({ message: 'Write to setting.json?', default: true })) {
        writeJsonSync(`${process.cwd()}/data/setting.json`, setting)
        console.log('Done!')
    } else {
        console.log(JSON.stringify(setting, null, 4))
    }
    console.log(chalk.bold(`Use ${chalk.bgGrey.whiteBright('tool/register.js')} to register commands`))
})()