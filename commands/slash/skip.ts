import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import {
	getAudioPlayer,
	getBotVoiceChannel,
	getConnection,
} from "../../lib/voice/core";
import { type Command } from "../../lib/interaction";
import { languageText } from "../../lib/language";
import { globalApp } from "../../lib/misc";

const VOTE_BUTTON_ID = "skip_vote";

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
			const skipAmount = Math.min(player.queue.length + 1, amount);
			const playCount = player.playCounter;
			const voteRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(VOTE_BUTTON_ID)
					.setLabel(languageText("skip_label", language))
					.setStyle(ButtonStyle.Primary),
			);
			await interaction.editReply({
				content: languageText("skip_vote", language, {
					requiredAmount,
					skipAmount,
				}),
				components: [voteRow],
			});
			if (!message.resource?.message) throw new Error("No message found");
			const voters = new Set<string>();
			try {
				const collector =
					message.resource.message.createMessageComponentCollector({
						componentType: ComponentType.Button,
						time: 15 * 1000,
					});
				await new Promise<void>((resolve, reject) => {
					collector.on("collect", async (button) => {
						if (button.customId !== VOTE_BUTTON_ID) return;
						if (
							button.user.bot ||
							!botVoiceChannel.members.has(button.user.id)
						) {
							return await button.reply({
								content: languageText(
									"skip_vote_not_in_voice",
									language,
								),
								flags: MessageFlags.Ephemeral,
							});
						}
						if (voters.has(button.user.id)) {
							return await button.reply({
								content: languageText(
									"skip_vote_already",
									language,
								),
								flags: MessageFlags.Ephemeral,
							});
						}
						voters.add(button.user.id);
						if (voters.size >= requiredAmount) {
							collector.stop("passed");
							await button.update({ components: [] });
							return resolve();
						}
						await button.update({
							content: languageText("skip_vote_progress", language, {
								requiredAmount,
								skipAmount,
								votes: voters.size,
							}),
							components: [voteRow],
						});
					});
					collector.on("end", (_collected, reason) => {
						if (reason !== "passed") reject();
					});
				});
				if (playCount !== player.playCounter) {
					globalApp.warn(
						"Play count changed during vote, aborting skip",
					);
					return await interaction.editReply({
						content: languageText(
							"skip_vote_fail_song_changed",
							language,
						),
						components: [],
					});
				}
				await interaction.followUp(
					languageText("skip_vote_success", language),
				);
			} catch {
				return await interaction.editReply({
					content: languageText("skip_vote_fail", language),
					components: [],
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
