const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('test')
		.setDescription('Testing'),
	async execute(interaction) {
		interaction.reply({content: 'test'});
	},
};
