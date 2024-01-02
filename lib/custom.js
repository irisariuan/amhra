const { Client } = require('discord.js')
const { AudioPlayer } = require('@discordjs/voice')
const { SearchCache } = require('./cache')

class CustomClient extends Client {
    /**
     * @type {Map<string, CustomAudioPlayer>}
     */
    player = new Map()
    /**
     * @type {SearchCache}
     */
    cache = new SearchCache()
}

class CustomAudioPlayer extends AudioPlayer {
    volume = 1
    isPlaying = false
    queue = []
    /**
     * @type {{resource: AudioResource<any>, channel: YouTubeChannel, title: string, details: YouTubeVideo, url: string,} | null}
     */
    nowPlaying = null
    reset() {
        this.volume = 1
        this.isPlaying = false
        this.queue = []
        this.nowPlaying = null
    }
}

module.exports = {
    CustomClient, CustomAudioPlayer
}