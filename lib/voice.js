//@ts-check

const { AudioPlayer, createAudioResource, AudioPlayerStatus, joinVoiceChannel, getVoiceConnection, EndBehaviorType } = require("@discordjs/voice");
const { stream } = require('play-dl');
const { Queue } = require('./queue');
const fs = require('fs');

async function record(interaction, opts = {}) {
	const connection = getVoiceConnection(interaction.guildId);
	const memberId = interaction.member.id;
	const stream = connection.receiver.subscribe(memberId, {
        end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: 200,
        }
    });
    const writableStream = fs.createWriteStream(`${interaction.guild.name}.opus`);
    setTimeout(() => {
        console.log('Stopped recording and pipe into writeableStream');
        stream.pipe(writableStream);
        stream.on('close', () => {
            console.log('Stream closed');
        })
    }, 5000);
}

function getAudioPlayer(client, interaction, opts = {}) {
    let player = client.player.get(interaction.guild.id);
    if (!player) {
        player = new AudioPlayer(opts);
        player.isPlaying = false;
        player.queue = [];
        player.on(AudioPlayerStatus.Idle, () => {
            console.log("Status Idle");
            if (player.queue.length > 0) {
                const nextResource = player.queue.shift();
                player.play(nextResource);
                console.log('Played next music');
            } else {
                player.isPlaying = false;
                console.log('Finished playing music')
            }
        })
        client.player.set(interaction.guild.id, player);
        return player;
    }
    return player;
}

async function createResource(url) {
    const source = await stream(url);
    const res = createAudioResource(source.stream, { inputType: source.type });
    return res;
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

module.exports = { getAudioPlayer, createResource, record, joinVoice, isPlaylist, isVideo }
