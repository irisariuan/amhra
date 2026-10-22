import { SlashCommandBuilder } from "discord.js";
import { getAudioPlayer } from "../../lib/voice/core";
import type { Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";
import { indexChoices } from "../../lib/autocompletePlan";

export default {
	data: new SlashCommandBuilder()
		.setName("remove")
		.setDescription("Remove a song from queue")
		.addIntegerOption((opt) =>
			opt
				.setName("index")
				.setDescription("Index of the item you would like to remove")
				.setMinValue(1)
				.setRequired(true)
				.setAutocomplete(true),
		),
	async autocomplete({ interaction, client }) {
		// Looked up directly: getAudioPlayer would also rebind the player's
		// channel and language, which only a real command should do.
		const player = interaction.guildId
			? client.player.get(interaction.guildId)
			: undefined;
		// Cached titles only: Discord drops an answer that takes over three
		// seconds, too short to look up every song in a long queue.
		const labels = (player?.queue ?? []).map(
			(item) => client.cache.getUrl(item.url)?.value?.title || item.url,
		);
		return interaction.respond(indexChoices(labels, interaction.options.getFocused()));
	},
	async execute({ interaction, client, language }) {
		if (!interaction.guildId)
			return await interaction.reply({
				content: languageText("server_only_command", language),
			});

		const player = getAudioPlayer(
			client,
			interaction.guildId,
			interaction.channel,
			language,
			{ createPlayer: false },
		);
		const index = interaction.options.getInteger("index", true);
		if (!player) {
			await interaction.reply({
				content: languageText("not_playing", language),
			});
			return;
		}
		if (index > player.queue.length)
			return await interaction.reply({
				content: languageText("queue_index_overflow", language),
			});
		const removed = player.queue.splice(index - 1, 1)[0];
		const videoDetail = client.cache.getUrl(removed.url)?.value;
		if (videoDetail?.title)
			return interaction.reply({
				content: languageText("remove_queue_detail", language, {
					title: videoDetail.title,
					removed: removed.url,
				}),
			});
		return interaction.reply({
			content: languageText("remove_queue", language, {
				removed: removed.url,
			}),
		});
	},
} as Command<SlashCommandBuilder>;
