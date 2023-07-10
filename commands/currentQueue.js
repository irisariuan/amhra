const { SlashCommandBuilder } = require('@discordjs/builders');
const { getAudioPlayer, getConnection, songToStr } = require('../lib/voice');
const { MessageEmbed, BaseCommandInteraction } = require('discord.js');
const yts = require('yt-search');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('queue')
		.setDescription('Show the songs going to be played')
		.addIntegerOption(opt => opt.setMinValue(1).setName('page').setDescription('Page number of queue')),
	/**
	 * 
	 * @param {BaseCommandInteraction} interaction 
	 * @param {*} client 
	 * @returns 
	 */
	async execute(interaction, client) {
		await interaction.deferReply();
		const player = getAudioPlayer(client, interaction);
		if (!getConnection(interaction)) {
			console.log('Bot not in voice channel');
			return interaction.editReply({ content: "I'm not in a voice channel!" });
		} else if (!player) {
			console.log('Bot not playing song');
			return interaction.editReply({ content: "I'm not playing anything!" });
		} else if (player.queue.length <= 0) {
			console.log('Queue clear')
			return interaction.editReply({ content: 'There is no more things to be played!' });	
		}

		result = ''

		let startPoint = interaction.options.get('page') ?? 0
		let endPoint = (startPoint + 5 >= player.queue.length) ? player.queue.length - 1 : startPoint + 5

		for (const i of player.queue.slice(startPoint, endPoint)) {
			let videoId = i.match(/^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/)[7]
			let data = await yts({videoId})
		    result += songToStr({details: {durationInSec: data.seconds}, title: data.title}, i+1) + '\n';
		}

        const embed = new MessageEmbed().setTitle('Upcoming Songs').setColor('CF2373').addField('In queue', result.slice(0, -1));
		
		if (player.queue.length > 6) {
            if (player.queue.length === 7) {
                embed.setFooter({text: `There are 1 more song in the queue`});
            }
            embed.setFooter({text: `There are ${player.queue.length - 6} more songs in the queue`});
        }
		await interaction.editReply({embeds: [embed]})
	},
};
