const { Client } = require('discord.js')

class CustomClient extends Client {
    player = new Map()
}

module.exports = {
    CustomClient
}