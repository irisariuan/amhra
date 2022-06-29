//@ts-check

const { SlashCommandBuilder } = require('@discordjs/builders');
const { joinVoiceChannel, AudioPlayerStatus } = require('@discordjs/voice');
const { getAudioPlayer, createResource, isVideo, isPlaylist, joinVoice } = require('../lib/voice');
const yts = require('yt-search');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('play')
		.setDescription('Play music')
		.addStringOption(opt => opt.setName('search').setDescription('Play a link or searching on YouTube').setRequired(true)),
	async execute(interaction, client) {
		const input = interaction.options.get('search').value;

		let url = input;
		if (!isVideo(input)) {
			const result = await yts(input);
			url = result.videos[0].url
		} else if (isPlaylist) {
			return;
		}

		let voiceChannel = interaction.member.voice.channel;
		if (!voiceChannel) return;

		const connection = joinVoice(voiceChannel, interaction);
		console.log('Connected');
		const audioPlayer = getAudioPlayer(client, interaction);
		connection.subscribe(audioPlayer);

		console.log('Start creating resource');
		const resource = await createResource(url);``
		console.log('Created resource');

		audioPlayer.queue.push(resource);
		if (!audioPlayer.isPlaying) {
			console.log('Started to play music')
			audioPlayer.isPlaying = true;
			audioPlayer.play(audioPlayer.queue.pop());
			if (input !== url) {
				return await interaction.reply({
					content: `Playing ${input}(${url})`
				})
			}
			await interaction.reply({
				content: `Playing ${input}`
			})
		} else {
			console.log('Added into queue')
			if (input !== url) {
				return await interaction.reply({
					content: `Added ${input}(${url}) to queue`
				})
			}
			await interaction.reply({
				content: `Added ${input} into queue`
			})
		}
	}
};
