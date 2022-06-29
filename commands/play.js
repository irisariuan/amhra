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
		//prevent error caused by long response time
		await interaction.deferReply();
		console.log('Called /play')
		/**
		 * @type {string}
		 */
		const input = interaction.options.getString('search');
		
		let voiceChannel = interaction.member.voice.channel;
		if (!voiceChannel) return;
		
		const connection = joinVoice(voiceChannel, interaction);
		console.log('Connected');
		const audioPlayer = getAudioPlayer(client, interaction);
		connection.subscribe(audioPlayer);

		let url = input;
		
		if (!isVideo(input)) {
			const result = await yts(input);
			url = result.videos[0].url
		} else if (isPlaylist(input)) {
			const result = await yts({listId: input.match(/list=.+&|list=.+/)[0].slice(5)});
			audioPlayer.queue = audioPlayer.queue.concat(result.videos.map(v => 'https://www.youtube.com/watch?v=' + v.videoId))
			// return await interaction.reply({
			// 	content: 'Playlist is currently not supported.',
			// 	ephemeral: true
			// });
		}

		audioPlayer.queue.push(url);
		if (!audioPlayer.isPlaying) {
			console.log('Started to play music');
			try {
				const data = await createResource(audioPlayer.queue.shift());
				data.resource.volume.setVolume(audioPlayer.volume)
				audioPlayer.isPlaying = true;
				//function of reduce is (old, new) => {value}, init, run it from left to right
				//audioPlayer.nowPlaying = Object.keys(data).filter(d => d !== 'resource').reduce((obj, key) => {obj[key] = data[key]; return obj}, {});
				audioPlayer.nowPlaying = data;
				audioPlayer.play(data.resource);
				if (isPlaylist(url)) {
					console.log('Playing playlist')
					const result = await yts({listId: input.match(/list=.+&|list=.+/)[0].slice(5)})
					if (!result) return await interaction.editReply({content: 'Cannot find any playlist!'})
					return await interaction.editReply({
						content: `Playing playlist ${result.title} (${result.url})`
					})
				}
				if (input !== url) {
					console.log('Playing Searched URL');
					return await interaction.editReply({
						content: `Playing ${data.title} (${url})`
					})
				}
				console.log('Interaction inclued the URL');
				await interaction.editReply({
					content: `Playing ${data.title}`
				})
			} catch (error) {
				console.log('An error occurred while trying to start playing music: ' + error)
				interaction.editReply({
					content: 'An error occurred while processing the song',
					ephemeral: true
				})
			}
		} else {
			console.log('Added into queue')
			if (input !== url) {
				console.log('Searched URL and added URL to queue');
				return await interaction.editReply({
					content: `Added ${input}(${url}) to queue`
				})
			}
			console.log('Added URL to queue')
			await interaction.editReply({
				content: `Added ${input} into queue`
			})
		}
	}
};
