import { type Command } from "../../lib/interaction";

import { SlashCommandBuilder } from "discord.js";
import { languageText } from "../../lib/language";
import { dcb, misc } from "../../lib/misc";
import { searchYouTube } from "../../lib/youtube";
import {
	ensureVoiceConnection,
	getAudioPlayer,
	getBotVoiceChannel,
	getConnection,
	isPlaylist,
	isVideo,
} from "../../lib/voice/core";
import {
	discordTime,
	listSchedules,
	requestSchedule,
	respondToSchedule,
} from "../../lib/voice/schedule";
import { parseScheduleTime } from "../../lib/voice/schedulePlan";

export default {
	data: new SlashCommandBuilder()
		.setName("schedule")
		.setDescription("Schedule a video to cut in at a set time")
		.addSubcommand((sub) =>
			sub
				.setName("add")
				.setDescription(
					"Schedule a video to cut in, premieres are timed automatically",
				)
				.addStringOption((opt) =>
					opt
						.setName("search")
						.setDescription("A video link or a search on YouTube")
						.setRequired(true),
				)
				.addStringOption((opt) =>
					opt
						.setName("time")
						.setDescription(
							"10m, 1h30m, 21:30, 2026-10-22 21:30 or a Discord timestamp; leave empty for a premiere",
						),
				),
		)
		.addSubcommand((sub) =>
			sub.setName("list").setDescription("Show what is scheduled"),
		)
		.addSubcommand((sub) =>
			sub
				.setName("cancel")
				.setDescription("Cancel a scheduled play")
				.addIntegerOption((opt) =>
					opt
						.setName("index")
						.setDescription("The number shown by /schedule list")
						.setMinValue(1)
						.setRequired(true),
				),
		),
	async execute({ interaction, client, language }) {
		if (!interaction.guild)
			return await interaction.reply({
				content: languageText("server_only_command", language),
			});
		const guildId = interaction.guild.id;
		const subcommand = interaction.options.getSubcommand(true);

		if (subcommand === "list") {
			const entries = listSchedules(guildId);
			if (!entries.length)
				return interaction.reply(languageText("schedule_empty", language));
			const lines = entries.map((entry, i) =>
				languageText("schedule_list_item", language, {
					index: i + 1,
					title: entry.title,
					url: entry.url,
					premiere: entry.premiere
						? languageText("schedule_premiere_tag", language)
						: "",
					...discordTime(entry.at),
				}),
			);
			return interaction.reply({
				content: [languageText("schedule_list_header", language), ...lines].join("\n"),
				flags: ["SuppressEmbeds"],
			});
		}

		if (subcommand === "cancel") {
			const index = interaction.options.getInteger("index", true);
			const entry = listSchedules(guildId)[index - 1];
			if (
				!entry ||
				!(await respondToSchedule(
					guildId,
					entry.id,
					"cancelled",
					interaction.user.displayName,
				))
			) {
				return interaction.reply(
					languageText("schedule_not_found", language, { index }),
				);
			}
			return interaction.reply(
				languageText("schedule_cancelled", language, {
					title: entry.title,
					by: interaction.user.displayName,
				}),
			);
		}

		// add: the same voice checks as /play, since the bot joins to wait
		if (
			!interaction.member ||
			!("voice" in interaction.member) ||
			!interaction.member.voice.channel
		)
			return await interaction.reply({
				content: languageText("user_not_in_voice", language),
			});
		const botVoiceChannel = getBotVoiceChannel(interaction.guild, client);
		if (
			botVoiceChannel &&
			getConnection(guildId) &&
			interaction.member.voice.channel.id !== botVoiceChannel.id
		) {
			return await interaction.reply({
				content: languageText("not_same_voice", language),
			});
		}

		const input = interaction.options.getString("search", true);
		const timeInput = interaction.options.getString("time");
		let at: number | null = null;
		if (timeInput) {
			at = parseScheduleTime(timeInput, Date.now());
			if (at === null)
				return interaction.reply(languageText("schedule_bad_time", language));
			if (at <= Date.now())
				return interaction.reply(languageText("schedule_past_time", language));
		}
		if (isPlaylist(input))
			return interaction.reply(languageText("schedule_video_only", language));

		await interaction.deferReply();

		let url = input;
		if (!isVideo(input)) {
			const results = await searchYouTube(input);
			if (!results[0])
				return interaction.editReply(
					languageText("schedule_not_found_video", language),
				);
			url = results[0].url;
		}

		const result = await requestSchedule({
			guildId,
			url,
			at,
			channelId: interaction.channelId,
			createdBy: interaction.user.displayName,
			language,
		});
		if ("error" in result) {
			const key = {
				not_found: "schedule_not_found_video",
				need_time: "schedule_need_time",
				past: "schedule_past_time",
			}[result.error];
			return interaction.editReply(languageText(key, language));
		}

		// Joined now rather than at the time: the bot waits in the channel,
		// and leaving it is what clears the schedule
		const connection = ensureVoiceConnection(interaction);
		const player = getAudioPlayer(client, guildId, interaction.channel, language);
		if (!connection || !player) {
			await respondToSchedule(guildId, result.entry.id, "cancelled", "join failed");
			return interaction.editReply(misc.errorMessageObj(language));
		}
		connection.subscribe(player);
		dcb.log(`Scheduled ${result.entry.url} from /schedule`);

		const { entry } = result;
		return interaction.editReply({
			content: languageText(
				entry.premiere && at === null ? "schedule_premiere_added" : "schedule_added",
				language,
				{ title: entry.title, url: entry.url, ...discordTime(entry.at) },
			),
		});
	},
} as Command<SlashCommandBuilder>;
