import { SlashCommandBuilder } from "discord.js";
import {
	getAudioPlayer,
	getBotVoiceChannel,
	getConnection,
} from "../../lib/voice/core";
import { type Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";
import { globalApp } from "../../lib/misc";

export default {
	data: new SlashCommandBuilder()
		.setName("skip")
		.setDescription("Skip the song")
		.addBooleanOption((option) =>
			option
				.setName("force")
				.setDescription("Force skip the song (no vote)")
				.setRequired(false),
		)
		.addIntegerOption((option) =>
			option
				.setName("amount")
				.setDescription("The number of songs to skip")
				.setRequired(false)
				.setMinValue(1),
		),
	async execute({ interaction, client, language }) {
		if (!interaction.guild)
			return await interaction.reply({
				content: languageText("server_only_command", language),
			});
		if (
			!interaction.member ||
			!("voice" in interaction.member) ||
			!interaction.member.voice.channel
		)
			return await interaction.reply({
				content: languageText("user_not_in_voice", language),
			});
		const botVoiceChannel = getBotVoiceChannel(interaction.guild, client);
		const connection = getConnection(interaction.guild.id);
		if (
			botVoiceChannel &&
			connection &&
			interaction.member.voice.channel.id !== botVoiceChannel.id
		) {
			return await interaction.reply({
				content: languageText("not_same_voice", language),
			});
		}
		const amount = interaction.options.getInteger("amount") ?? 1;
		const force = interaction.options.getBoolean("force") ?? false;
		const player = getAudioPlayer(
			client,
			interaction.guild.id,
			interaction.channel,
			language,
			{ createPlayer: false },
		);
		if (!player || !player.isPlaying)
			return await interaction.reply(
				languageText("not_playing", language),
			);
		const message = await interaction.deferReply({ withResponse: true });
		if (
			botVoiceChannel?.members &&
			!force &&
			botVoiceChannel.members.size > 2
		) {
			const requiredAmount = Math.ceil(botVoiceChannel.members.size / 2);
			const playCount = player.playCounter;
			await interaction.editReply({
				content: languageText("skip_vote", language, {
					requiredAmount,
					skipAmount: Math.min(player.queue.length + 1, amount),
				}),
			});
			if (!message.resource?.message) throw new Error("No message found");
			await message.resource?.message?.react("✅");
			try {
				const collector =
					message.resource.message.createReactionCollector({
						filter: (reaction, user) => {
							return !!(
								reaction.emoji.name === "✅" &&
								!user.bot &&
								botVoiceChannel.members.find(
									(member) => member.id === user.id,
								)
							);
						},
						time: 15 * 1000,
					});
				await new Promise<void>((resolve, reject) => {
					collector.on("collect", (reaction) => {
						if (
							reaction.users.cache.filter((user) =>
								botVoiceChannel.members.find(
									(member) =>
										member.id === user.id && !user.bot,
								),
							).size >= requiredAmount
						)
							resolve();
					});
					collector.on("end", () => reject());
				});
				if (playCount !== player.playCounter) {
					globalApp.warn(
						"Play count changed during vote, aborting skip",
					);
					throw "";
				}
				await message.resource?.message?.reactions.removeAll();
				await interaction.followUp(
					languageText("skip_vote_success", language),
				);
			} catch {
				await message.resource?.message?.reactions.removeAll();
				return await message.resource?.message?.edit({
					content: languageText("skip_vote_fail", language),
				});
			}
		}
		player.stop();
		const queueSize = player.queue.length;
		if (amount > 1) {
			player.queue.splice(0, amount - 1);
		}
		await interaction.editReply({
			content: languageText("skip_song", language, {
				amount: Math.min(queueSize + 1, amount),
			}),
		});
	},
} as Command<SlashCommandBuilder>;
