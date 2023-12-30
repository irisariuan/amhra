// @ts-check
const { createAudioResource, AudioPlayerStatus, joinVoiceChannel, getVoiceConnection, AudioResource } = require("@discordjs/voice");
const { stream, video_info, YouTubeChannel, YouTubeVideo } = require('play-dl');
const { record } = require('./voice/record')
const { BaseCommandInteraction } = require("discord.js");
const { CustomAudioPlayer, CustomClient } = require('../lib/custom');
const { dcb } = require("./misc");

/** 
 * @param {CustomClient} client
 * @param {BaseCommandInteraction} interaction
 * @param {object} opts
 * @param {boolean} [opts.createPlayer=true]
 * @param {object} [opts.createOpts={}]
 * @param {boolean} [opts.fail=false]
 * @returns {( CustomAudioPlayer | boolean )}
 */
function getAudioPlayer(client, interaction, opts = { createPlayer: true, createOpts: {}, fail: false }) {
    if (!interaction.guild) {
        return opts.fail
    }
    let player = client.player.get(interaction.guild.id);
    if (!player && opts.createPlayer) {
        //create a player and initialize it if there isn't one
        player = new CustomAudioPlayer(opts.createOpts)
        //create the auto play event
        player.on(AudioPlayerStatus.Idle, async () => {
            if (!player) {
                return
            }
            try {
                dcb.log("Finished music playing");
                if (player.queue.length > 0) {
                    const nextData = player.queue.shift();
                    const resource = await createResource(nextData);

                    resource.resource.volume?.setVolume(player.volume);
                    player.nowPlaying = resource;
                    player.play(resource.resource);
                    dcb.log('Playing next music');
                } else {
                    player.isPlaying = false;
                    player.nowPlaying = null;
                    dcb.log('Finished playing music');
                }
            } catch (error) {
                dcb.log('Error: ' + error)
                player.isPlaying = false;
                player.nowPlaying = null;
            }
        })
        client.player.set(interaction.guild.id, player);
        return player;
    }
    if (!player && !opts.createPlayer) {
        return opts.fail;
    }
    return player;
}

/**
 * @param {CustomClient} client
 * @param {BaseCommandInteraction} interaction
 * @returns {boolean}
*/
function destoryAudioPlayer(client, interaction) {
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
 * @returns {Promise<{resource: AudioResource, channel: YouTubeChannel, title: String, details: YouTubeVideo, url: String}>}
 */
async function createResource(url) {
    const source = await stream(url);
    const videoInfo = await video_info(url);
    const detail = videoInfo.video_details;
    const res = createAudioResource(source.stream, { inputType: source.type, inlineVolume: true });
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

function isVideo(link) {
    return link.match(/^(https?:\/\/)?(www\.)?(m\.|music\.)?(youtube\.com|youtu\.?be)\/.+$/gi)
}

function isPlaylist(link) {
    return link.match(/^.*(list=)([^#\&\?]*).*/gi)
}

function songToStr(d, i = null) {
    const date = new Date(0);
    date.setSeconds(d.details.durationInSec);
    return (i ? `\`${i}.\` ` : '') + `${d.title} \`${date.toISOString().slice(11, 19)}\``
}

module.exports = { getAudioPlayer, createResource, record, joinVoice, ensureConnection, getConnection, isPlaylist, isVideo, songToStr, destoryAudioPlayer }