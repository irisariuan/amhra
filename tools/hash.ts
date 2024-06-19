import crypto from 'node:crypto'
import { input, confirm } from '@inquirer/prompts'
import { writeJsonSync, readJsonSync } from '../lib/read'

input({ message: 'Hash' }).then(async v => {
    const hash = crypto.createHash('sha256').update(`Basic ${v}`).digest('hex')
    console.log(hash)
    if (await confirm({ message: 'Write to setting.json?' })) {
        const setting = readJsonSync(`${process.cwd()}/data/setting.json`)
        setting.AUTH_TOKEN = hash
        writeJsonSync(`${process.cwd()}/data/setting.json`, setting)
    }
})