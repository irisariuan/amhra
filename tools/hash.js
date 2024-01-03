const crypto = require('crypto')
const { input } = require('@inquirer/prompts')

input({message: 'Hash'}).then(v => {
    console.log(crypto.createHash('sha256').update('Basic ' + v).digest('hex'))
})