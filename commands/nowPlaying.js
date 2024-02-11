const { SlashCommandBuilder, CommandInteraction } = require("discord.js")
const { EmbedBuilder } = require("discord.js")
const { getAudioPlayer, songToString } = require("../lib/voice/core")
const { CustomClient } = require("../lib/custom")

module.exports = {
	data: new SlashCommandBuilder()
		.setName("nowplaying")
		.setDescription("Show the song playing"),
	/**
	 * @param {CommandInteraction} interaction
	 * @param {CustomClient} client
	 **/
	execute(interaction, client) {
		const player = getAudioPlayer(client, interaction, { createPlayer: false })
		if (!player) return interaction.reply({ content: "Not playing any song" })
		if (!player.nowPlaying)
			return interaction.reply({ content: "Not playing any song" })
		interaction.reply({
			embeds: [
				new EmbedBuilder()
					.setTitle("Now Playing")
					.setDescription(songToString(player.nowPlaying)),
			],
		})
	},
}
