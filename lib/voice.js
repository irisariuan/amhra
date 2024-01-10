// @ts-check
const { createAudioResource, AudioPlayerStatus, joinVoiceChannel, getVoiceConnection, AudioResource } = require("@discordjs/voice");
const { stream, video_info, YouTubeChannel, YouTubeVideo, yt_validate } = require('play-dl');
const { record } = require('./voice/record')
const { BaseCommandInteraction } = require("discord.js");
const { CustomAudioPlayer, CustomClient } = require('../lib/custom');
const { dcb, globalApp } = require("./misc");
const { event } = require("./express/event");

/**
 * 
 * @param {string} guildId 
 * @param {object} createOpts 
 * @returns 
 */
function createAudioPlayer(guildId, createOpts = {}) {
    //create a player and initialize it if there isn't one
    const player = new CustomAudioPlayer(createOpts)

    // how every player reacts when received song from web
    event.on('songInterruption', async (gid, action, detail) => {
        if (gid !== guildId) {
            return
        }
        switch (action) {
            case 'pause':
                player.pause()
                break
            case 'resume':
                player.unpause()
                break
            case 'setTime':
                if (!player.nowPlaying) {
                    globalApp.err('Cannot interrupt the song since nothing is playing')
                    return
                }
                if (detail.sec > player.nowPlaying.details.durationInSec - 5) {
                    globalApp.err('Out of range')
                    return
                }

                const res = await createResource(player.nowPlaying.url, detail.sec)
                player.playResource({ resource: res.resource, channel: player.nowPlaying.channel, details: player.nowPlaying.details, title: player.nowPlaying.title, url: player.nowPlaying.url })
            case 'addSong':
                dcb.log('Added song from dashboard to queue')
                player.queue.push(detail.url)
                if (!player.isPlaying) {
                    const p = player.queue.shift()
                    const res = await createResource(p)

                    event.emit('songInfo', p)
                    res.resource.volume?.setVolume(player.volume)
                    player.play(res.resource)
                    dcb.log('Started playing song from queue')
                }
                break
            case 'stop':
                dcb.log('Stop the music from dashboard')
                player.cleanStop()
                break
            case 'skip':
                dcb.log('Skip the music from dashboard')
                player.stop()
            default:
                break
        }
    })

    //continue to play song after ending one
    player.on(AudioPlayerStatus.Idle, async () => {
        if (!player) {
            return
        }
        try {
            dcb.log("Finished music playing");
            if (player.queue.length > 0) {
                const nextUrl = player.queue.shift();
                const resource = await createResource(nextUrl);

                event.emit('songInfo', nextUrl)
                player.playResource(resource)
                dcb.log('Playing next music');
            } else {
                player.isPlaying = false;
                player.nowPlaying = null;
                dcb.log('Finished playing all music');
                player.cleanStop()
            }
        } catch (error) {
            dcb.log('Error: ' + error)
            player.isPlaying = false;
            player.nowPlaying = null;
        }
    })
    return player;
}

/** 
 * @param {CustomClient} client
 * @param {BaseCommandInteraction} interaction
 * @param {object} opts
 * @param {boolean} [opts.createPlayer=true]
 * @param {object} [opts.createOpts={}]
 * @param {boolean} [opts.fail=false]
 * @returns {( CustomAudioPlayer | null )}
 */
function getAudioPlayer(client, interaction, opts = { createPlayer: true, createOpts: {}, fail: false }) {
    if (!interaction.guild) {
        return null
    }

    let player = client.player.get(interaction.guild.id);

    if (!player && opts.createPlayer) {
        const player = createAudioPlayer(interaction.guild.id, {})
        client.player.set(interaction.guild.id, player);
        return player
    }

    if (!player) {
        return null
    }

    return player;
}

/**
 * @param {CustomClient} client
 * @param {BaseCommandInteraction} interaction
 * @returns {boolean}
*/
function destroyAudioPlayer(client, interaction) {
    if (!interaction.guild || !interaction.guildId) {
        return false
    }
    if (client.player.has(interaction.guild.id)) {
        // reset player to the init status
        client.player.get(interaction.guildId)?.reset()
        client.player.delete(interaction.guildId)
        return true
    }
    return false
}

function getConnection(interaction) {
    const connection = getVoiceConnection(interaction.guildId);
    if (!connection) return false;
    return connection;
}

function ensureConnection(interaction, fail = false) {
    let connection = getConnection(interaction);
    if (!connection) {
        if (!interaction.member.voice.channel) return fail;
        return joinVoice(interaction.member.voice.channel, interaction);
    }
    return connection;
}

/**
 * 
 * @param {String} url 
 * @param {number | undefined} seek
 * @returns {Promise<{resource: AudioResource, channel: YouTubeChannel, title: String, details: YouTubeVideo, url: String}>}
 */
async function createResource(url, seek = undefined) {
    const source = await stream(url, { seek });
    const videoInfo = await video_info(url);
    const detail = videoInfo.video_details;
    const res = createAudioResource(source.stream, { inputType: source.type, inlineVolume: true });
    if (!detail.channel || !detail.title) {
        throw new Error('Resource could not be created due to missing channel and title')
    }
    return { resource: res, channel: detail.channel, title: detail.title, details: detail, url };
}

function joinVoice(voiceChannel, interaction) {
    return joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });
}

function isYoutube(query) {
    return yt_validate(query) !== false
}

function isVideo(link) {
    return yt_validate(link) === 'video'
}

function isPlaylist(link) {
    return yt_validate(link) === 'playlist'
}

// https://stackoverflow.com/questions/3733227/javascript-seconds-to-minutes-and-seconds
function timeFormat(duration) {
    let dur = duration
    if (typeof duration === 'string') {
        dur = parseInt(duration)
    }
    // Hours, minutes and seconds
    const hrs = ~~(dur / 3600);
    const mins = ~~((dur % 3600) / 60);
    const secs = ~~dur % 60;

    // Output like "1:01" or "4:03:59" or "123:03:59"
    let ret = "";

    if (hrs > 0) {
        ret += "" + hrs + ":" + (mins < 10 ? "0" : "");
    }

    ret += "" + mins + ":" + (secs < 10 ? "0" : "");
    ret += "" + secs;

    return ret;
}


function songToStr(d, i = null) {
    return (i ? `\`${i}.\` ` : '') + `${d.title} \`${timeFormat(d.details.durationInSec || d.durationInSec)}\``
}

module.exports = { getAudioPlayer, createResource, record, joinVoice, ensureConnection, getConnection, isPlaylist, isVideo, isYoutube, songToStr, destroyAudioPlayer }