const { SlashCommandBuilder } = require('@discordjs/builders');
const { joinVoiceChannel, AudioPlayerStatus } = require('@discordjs/voice');
const { getAudioPlayer, createResource, isVideo, isPlaylist, joinVoice } = require('../lib/voice');
const { playlist_info, search } = require('play-dl')
const { CustomClient } = require('../lib/client');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('play')
		.setDescription('Play music')
		.addStringOption(opt => opt.setName('search').setDescription('Play a link or searching on YouTube').setRequired(true)),
	/**
	 * 
	 * @param {BaseCommandInteraction} interaction 
	 * @param {CustomClient} client 
	 * @returns 
	 */
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
		let playlistInfo = null

		if (!isVideo(input)) {
			const result = await search(input, { limit: 1 });
			url = result[0].url
		} else if (isPlaylist(input)) {
			playlistInfo = await playlist_info(url, {incomplete: true})
			audioPlayer.queue = audioPlayer.queue.concat((await playlistInfo.all_videos()).map(v => v.url))
		}

		audioPlayer.queue.push(url);
		if (!audioPlayer.isPlaying) {
			console.log('Started to play music');
			try {
				const data = await createResource(audioPlayer.queue.shift());
				data.resource.volume.setVolume(audioPlayer.volume)
				audioPlayer.isPlaying = true;
				audioPlayer.nowPlaying = data;
				
				audioPlayer.play(data.resource);
				
				if (isPlaylist(url)) {
					console.log('Playing playlist')
					if (!playlistInfo) return await interaction.editReply({ content: 'Cannot find any playlist!' })
					return await interaction.editReply({
						content: `Playing playlist ${playlistInfo.title} (${playlistInfo.url})`
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
				console.error('An error occurred while trying to start playing music: ', error)
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
