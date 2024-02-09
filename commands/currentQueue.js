const { SlashCommandBuilder } = require("@discordjs/builders")
const { getAudioPlayer, getConnection, songToString } = require("../lib/voice/core")
const { MessageEmbed, BaseCommandInteraction } = require("discord.js")
const { video_info } = require("play-dl")
const { CustomClient } = require("../lib/custom")
const { dcb } = require("../lib/misc")

module.exports = {
	data: new SlashCommandBuilder()
		.setName("queue")
		.setDescription("Show the songs going to be played")
		.addIntegerOption(opt =>
			opt.setMinValue(1).setName("page").setDescription("Page number of queue")
		),
	/**
	 *
	 * @param {BaseCommandInteraction} interaction
	 * @param {CustomClient} client
	 * @returns
	 */
	async execute(interaction, client) {
		await interaction.deferReply()
		const player = getAudioPlayer(client, interaction)
		if (!getConnection(interaction)) {
			dcb.log("Bot not in voice channel")
			return interaction.editReply({ content: "I'm not in a voice channel!" })
		} else if (!player) {
			dcb.log("Bot not playing song")
			return interaction.editReply({ content: "I'm not playing anything!" })
		} else if (player.queue.length <= 0) {
			dcb.log("Queue clear")
			return interaction.editReply({
				content: "There is no more things to be played!",
			})
		}

		let pageNo = interaction.options.getInteger("page")
		let startPoint = pageNo > 0 ? (pageNo - 1) * 5 : 0
		if (pageNo * 5 > player.queue.length) {
			// set it to last page if the page over maximum
			startPoint = Math.floor(player.queue.length / 5) * 5
		}

		let endPoint =
			startPoint + 5 >= player.queue.length
				? player.queue.length
				: startPoint + 5

		result = ""
		const songs = player.queue.slice(startPoint, endPoint)
		for (let i = 0; i < songs.length; i++) {
			if (!songs[i]) {
				continue
			}
			const cachedUrl = client.cache.getUrl(songs[i])
			if (cachedUrl) {
				dcb.log("Founded cache, using cached URL")
			}
			let data = cachedUrl ?? (await video_info(songs[i])).video_details
			
			result +=
				songToString(
					{ details: { durationInSec: data.durationInSec }, title: data.title },
					i + 1 + startPoint
				) + "\n"
		}

		if (!result) {
			return await interaction.editReply({
				ephemeral: true,
				content: "An error occurred during running this action",
			})
		}

		const embed = new MessageEmbed()
			.setTitle("Upcoming Songs")
			.setColor("CF2373")
			.addFields({ name: "In queue", value: result.slice(0, -1) })

		const remainSongNo = player.queue.length - startPoint - 5
		if (remainSongNo > 0) {
			if (remainSongNo === 1) {
				embed.setFooter({ text: `There are 1 more song in the queue` })
			}
			embed.setFooter({
				text: `There are ${remainSongNo} more songs in the queue`,
			})
		} else {
			embed.setFooter({ text: "This is the end of the queue!" })
		}

		dcb.log("Sent queue")
		await interaction.editReply({ embeds: [embed] })
	},
}
