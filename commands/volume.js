const { SlashCommandBuilder } = require('@discordjs/builders');
const { getAudioPlayer, getConnection } = require('../lib/voice');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('volume')
		.setDescription('Set volume of the bot')
		.addIntegerOption(opt => opt.setName('volume').setDescription('Set the volume of the bot').setMinValue(0).setMaxValue(200).setRequired(true)),
	/**
	 * @param {BaseCommandInteraction} interaction 
	 * @param {Client} client 
	 */
	async execute(interaction, client) {
		const vol = interaction.options.getInteger('volume') / 100;
		const player = getAudioPlayer(client, interaction, {createPlayer: false});
		if (!getConnection(interaction)) return await interaction.reply({ content: "I'm not in a voice channel!" })
		if (!player) return await interaction.reply({ content: "I'm not playing song!"})
		player.volume = vol;
		await interaction.reply({ content: `Set the volume to ${vol*100}%` })
		if (!player.isPlaying) return;
		console.log(player.nowPlaying.resource);
		player.nowPlaying.resource.volume.setVolume(vol);
	}
};
