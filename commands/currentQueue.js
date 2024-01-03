const { SlashCommandBuilder } = require('@discordjs/builders');
const { getAudioPlayer, getConnection, songToStr } = require('../lib/voice');
const { MessageEmbed, BaseCommandInteraction } = require('discord.js');
const { video_info } = require('play-dl')
const { CustomClient } = require('../lib/custom');
const { dcb } = require('../lib/misc');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('queue')
		.setDescription('Show the songs going to be played')
		.addIntegerOption(opt => opt.setMinValue(1).setName('page').setDescription('Page number of queue')),
	/**
	 * 
	 * @param {BaseCommandInteraction} interaction 
	 * @param {CustomClient} client 
	 * @returns 
	 */
	async execute(interaction, client) {
		await interaction.deferReply();
		const player = getAudioPlayer(client, interaction);
		if (!getConnection(interaction)) {
			dcb.log('Bot not in voice channel');
			return interaction.editReply({ content: "I'm not in a voice channel!" });
		} else if (!player) {
			dcb.log('Bot not playing song');
			return interaction.editReply({ content: "I'm not playing anything!" });
		} else if (player.queue.length <= 0) {
			dcb.log('Queue clear')
			return interaction.editReply({ content: 'There is no more things to be played!' });
		}

		result = ''

		let startPoint = interaction.options.get('page') ?? 0
		let endPoint = (startPoint + 5 >= player.queue.length) ? player.queue.length : startPoint + 5

		const q = player.queue.slice(startPoint, endPoint)
		for (let i = 0; i < q.length; i++) {
			const c = client.cache.getUrl(q[i])
			if (c) {
				dcb.log('Founded cache, using cached URL')
			}
			let data = c ?? await video_info(q[i])
			result += songToStr({ details: { durationInSec: data.durationInSec }, title: data.title }, i + 1) + '\n'
		}

		const embed = new MessageEmbed().setTitle('Upcoming Songs').setColor('CF2373').addFields({ name: 'In queue', value: result.slice(0, -1) });

		if (player.queue.length > 6) {
			if (player.queue.length === 7) {
				embed.setFooter({ text: `There are 1 more song in the queue` });
			}
			embed.setFooter({ text: `There are ${player.queue.length - 6} more songs in the queue` });
		}

		dcb.log('Sent queue')
		await interaction.editReply({ embeds: [embed] })
	},
};
