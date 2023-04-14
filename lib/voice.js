const { AudioPlayer, createAudioResource, AudioPlayerStatus, joinVoiceChannel, getVoiceConnection, EndBehaviorType, AudioResource } = require("@discordjs/voice");
const { stream, video_info, YouTubeChannel, YouTubeVideo } = require('play-dl');
const { Queue } = require('./queue');
const fs = require('fs');
const prism = require('prism-media');
const { pipeline } = require("stream");
const { BaseCommandInteraction } = require("discord.js");

async function record(interaction, opts = {}) {
    // return await interaction.reply({ content: 'Currently not supported!' })
	//get voice connection, if there isn't one, create one
	let connection = getVoiceConnection(interaction.guildId);
	if (!connection) {
		if (!interaction.member.voice.channel) return false;
		connection = joinVoice(interaction.member.voice.channel, interaction)
	}
	const memberId = interaction.member.id;

	//create the stream and setup events
	const stream = connection.receiver.subscribe(memberId, {
        end: {
            behavior: EndBehaviorType.Manual
        }
    });
    stream.on('close', () => {
        console.log('Data Stream closed')
    });
    stream.on('error', (e) => {
        console.error(e)
    });
    //create the file stream
    const writableStream = fs.createWriteStream(`${opts.filename || interaction.guild.name}.${opts.format || 'ogg'}`);
    console.log('Created the streams, started recording');
    //todo: set the stream into client and stop it in another function
    //now: record 5s
    return setTimeout(async () => {
        //stop the stream
        stream.destroy();
        await new Promise((r) => {
            stream.on('close', () => {r()})
        })
        console.log('Stop recording');
        const oggWriter = new prism.opus.OggLogicalBitstream({
            opusHead: new prism.opus.OpusHead({
              channelCount: 2,
              sampleRate: 48000,
            }),
            pageSizeControl: {
              maxPackets: 10,
            },
          });
    
	    try {
            pipeline(stream, oggWriter, writableStream, (e) => { console.error(e) })
        } catch (e) {
            console.error(e);
        }
        // ffmpeg()
        // .input(stream)
        // .inputFormat('opus')
        // .format('mp3')
        // .output(`${interaction.guild.name}.mp3`)
        // .on('close', () => {
        	// console.log('Stream closed')
        // })
        // .on('error', (e) => {
        	// console.error(e)
        // })
    }, 5000);
}

/** 
 * @param client
 * @param {BaseCommandInteraction} interaction
 * @param {object} opts
 * @param {boolean} [opts.createPlayer=true]
 * @param {object} [opts.createOpts={}]
 * @param {boolean} [opts.fail=false]
 * @returns {( AudioPlayer )}
 */
function getAudioPlayer(client, interaction, opts = {createPlayer: true, createOpts: {}, fail: false}) {
    let player = client.player.get(interaction.guild.id);
    if (!player && opts.createPlayer) {
    	//create a player and initialize it if there isn't one
        player = new AudioPlayer(opts.createOpts);
        player.volume = 1;
        player.isPlaying = false;
        player.queue = [];
        player.nowPlaying = null;
        //create the auto play event
        player.on(AudioPlayerStatus.Idle, async () => {
            try {
                console.log("Finished music playing");
                if (player.queue.length > 0) {
                    const nextData = player.queue.shift();
                    const resource = await createResource(nextData);
            
                    resource.resource.volume.setVolume(player.volume);
                    player.nowPlaying = resource;
                    player.play(resource.resource);
                    console.log('Playing next music');
                } else {
                    player.isPlaying = false;
                    player.nowPlaying = null;
                    console.log('Finished playing music');
                }
            } catch (error) {
               console.log('Error: ' + error)
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
 * @param client
 * @param {BaseCommandInteraction} interaction
 * @returns {boolean}
*/
function destoryAudioPlayer(client, interaction) {
    if (client.player.has(interaction.guild.id)) {
        // reset player to the init status
        client.player.get(interaction.guildId).nowPlaying = null
        client.player.get(interaction.guildId).queue = []
        client.player.get(interaction.guildId).isPlaying = false
        client.player.get(interaction.guildId).volume = 1
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

function ensureConnection(client, interaction, fail=false) {
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

function isPlaylist(link){
    return link.match(/^.*(list=)([^#\&\?]*).*/gi)
}

function songToStr (d, i=null) {
	const date = new Date(0);
	date.setSeconds(d.details.durationInSec);
	return (i ? `\`${i}.\` `: '')+`${d.title} \`${date.toISOString().slice(11, 19)}\``
}

module.exports = { getAudioPlayer, createResource, record, joinVoice, ensureConnection, getConnection, isPlaylist, isVideo, songToStr, destoryAudioPlayer }
