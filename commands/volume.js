const { SlashCommandBuilder } = require("@discordjs/builders")
const { getAudioPlayer, getConnection } = require("../lib/voice/core")
const { CustomClient } = require("../lib/custom")

module.exports = {
	data: new SlashCommandBuilder()
		.setName("volume")
		.setDescription("Set volume of the bot")
		.addIntegerOption(opt =>
			opt
				.setName("volume")
				.setDescription("Set the volume of the bot")
				.setMinValue(0)
				.setMaxValue(200)
				.setRequired(true)
		),
	/**
	 * @param {BaseCommandInteraction} interaction
	 * @param {CustomClient} client
	 */
	execute(interaction, client) {
		const volume = interaction.options.getInteger("volume") / 100
		const player = getAudioPlayer(client, interaction, { createPlayer: false })
		if (!getConnection(interaction))
			return interaction.reply({ content: "I'm not in a voice channel!" })
		if (!player) return interaction.reply({ content: "I'm not playing song!" })
		player.setVolume(volume)
		interaction.reply({ content: `Set the volume to ${volume * 100}%` })
	},
}
