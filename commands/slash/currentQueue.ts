import type { Command } from "../../lib/interaction"

import { SlashCommandBuilder } from 'discord.js'
import {
	getAudioPlayer,
	getConnection,
	type TransformableResource
} from '../../lib/voice/core'
import { video_info } from 'play-dl'
import { dcb } from '../../lib/misc'
import { pageSize, sendPaginationMessage } from "../../lib/page"

export default {
	data: new SlashCommandBuilder()
		.setName('queue')
		.setDescription('Show the songs going to be played')
		.addIntegerOption(opt =>
			opt.setMinValue(1).setName('page').setDescription('Page number of queue')
		),
	async execute(interaction, client) {
		await interaction.deferReply()
		const player = getAudioPlayer(client, interaction)
		if (!getConnection(interaction.guildId)) {
			dcb.log('Bot not in voice channel')
			return interaction.editReply({ content: "I'm not in a voice channel!" })
		}
		if (!player) {
			dcb.log('Bot not playing song')
			return interaction.editReply({ content: "I'm not playing anything!" })
		}
		if (player.queue.length <= 0) {
			dcb.log('Queue clear')
			return interaction.editReply({
				content: 'There is no more things to be played!',
			})
		}

		const page = Math.min((interaction.options.getInteger('page') ?? 1) - 1, Math.ceil(player.queue.length / pageSize))

		sendPaginationMessage(async () => {
			const songs = player.queue || []
			const transformedSongs: TransformableResource[] = []
			for (let i = 0; i < songs.length; i++) {
				if (!songs[i]) {
					continue
				}
				const cachedUrl = client.cache.getUrl(songs[i])
				if (cachedUrl) {
					dcb.log('Founded cache, using cached URL')
				}
				const data = cachedUrl?.isVideo() ? cachedUrl?.value : (await video_info(songs[i])).video_details
				if (!cachedUrl) {
					client.cache.set(songs[i], data, "video")
				}

				transformedSongs.push({ details: { durationInSec: data.durationInSec }, title: data.title ?? '', url: songs[i] })
			}
			return transformedSongs
		}, interaction, page)
	},
} as Command<SlashCommandBuilder>
