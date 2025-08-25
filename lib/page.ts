import {
	ButtonBuilder,
	ButtonStyle,
	ActionRowBuilder,
	EmbedBuilder,
	time,
	ComponentType,
	type Message,
	type ChatInputCommandInteraction,
} from "discord.js";
import { timeFormat, type TransformableResource } from "./voice/core";
import { languageText } from "./language";
import { Language } from "./interaction";

export enum PageAction {
	PREVIOUS = "prev",
	NEXT = "next",
	REFRESH = "refresh",
	FIRST = "first",
	LAST = "last",
}

export function createButtons(
	page: number,
	contentLength: number,
	language: Language,
	maxPage: number = Math.ceil(contentLength / pageSize),
) {
	const prevBtn = new ButtonBuilder()
		.setCustomId(PageAction.PREVIOUS)
		.setLabel(languageText("previous_page_label", language))
		.setStyle(ButtonStyle.Primary);
	const nextBtn = new ButtonBuilder()
		.setCustomId(PageAction.NEXT)
		.setLabel(languageText("next_page_label", language))
		.setStyle(ButtonStyle.Primary);
	const refreshBtn = new ButtonBuilder()
		.setCustomId(PageAction.REFRESH)
		.setLabel(languageText("refresh_label", language))
		.setStyle(ButtonStyle.Secondary);
	const firstBtn = new ButtonBuilder()
		.setCustomId(PageAction.FIRST)
		.setLabel(languageText("first_page_label", language))
		.setStyle(ButtonStyle.Secondary);
	const lastBtn = new ButtonBuilder()
		.setCustomId(PageAction.LAST)
		.setLabel(languageText("last_page_label", language))
		.setStyle(ButtonStyle.Secondary);

	const row = new ActionRowBuilder<ButtonBuilder>();

	if (contentLength <= 0) {
		return row.addComponents(refreshBtn);
	}

	if (page <= 0) {
		prevBtn.setDisabled(true);
		firstBtn.setDisabled(true);
	}
	if (contentLength - (page + 1) * pageSize <= 0) {
		nextBtn.setDisabled(true);
		lastBtn.setDisabled(true);
	}
	row.addComponents(prevBtn, nextBtn, refreshBtn);
	if (maxPage > 1) {
		row.addComponents(firstBtn, lastBtn);
	}
	return row;
}

export function getPage(page: number, maxPage: number, pageAction: PageAction) {
	return Math.max(
		Math.min(
			pageAction === PageAction.PREVIOUS
				? page - 1
				: pageAction === PageAction.NEXT
					? page + 1
					: pageAction === PageAction.FIRST
						? 0
						: pageAction === PageAction.LAST
							? maxPage - 1
							: page,
			maxPage - 1,
		),
		0,
	);
}

export function createEmbed(
	result: TransformableResource[],
	page: number,
	language: Language,
) {
	return new EmbedBuilder()
		.setTitle(languageText("queue_label", language))
		.setTimestamp(Date.now())
		.setColor("DarkRed")
		.addFields(
			...result
				.map((v, i) => ({
					name: `${i + page * pageSize + 1}. ${v.title}`,
					value: [
						`${v.url} (${timeFormat(v.details.durationInSec)})`,
					].join("\n"),
				}))
				.slice(page * pageSize, (page + 1) * pageSize),
		)
		.setFooter({
			text: languageText("queue_footer", language, {
				minShowingSong: page * pageSize + 1,
				maxShowingSong: Math.min((page + 1) * pageSize, result.length),
				totalSong: result.length,
			}),
		});
}

export const pageSize = 20;

export async function sendPaginationMessage(
	getResult: () => Promise<TransformableResource[]>,
	interaction: ChatInputCommandInteraction,
	language: Language,
	initalPage = 0,
) {
	const result = await getResult();
	let interactionResponse: Message;
	let page = initalPage;
	if (!result || result.length <= 0) {
		interactionResponse = await interaction.editReply({
			content: languageText("no_song_found", language),
			embeds: [],
			components: [createButtons(0, 0, language)],
		});
	} else {
		interactionResponse = await editInteraction(
			result,
			interaction,
			page,
			language,
		);
	}

	interactionResponse
		.createMessageComponentCollector({
			componentType: ComponentType.Button,
		})
		.on("collect", async (i) => {
			i.deferUpdate();

			const reloadResult =
				i.customId === PageAction.REFRESH ? await getResult() : result;

			if (!reloadResult || reloadResult.length <= 0)
				return interaction.editReply({
					content: languageText("no_song_found", language),
					embeds: [],
					components: [createButtons(0, 0, language)],
				});

			const maxPage = Math.ceil(reloadResult.length / pageSize);
			page = getPage(page, maxPage, i.customId as PageAction);

			if (!reloadResult)
				return await interaction.editReply({
					content: languageText("no_song_found", language),
					embeds: [],
					components: [createButtons(0, 0, language)],
				});

			editInteraction(reloadResult, interaction, page, language);
		});
}

async function editInteraction(
	result: TransformableResource[],
	interaction: ChatInputCommandInteraction,
	page: number,
	language: Language,
) {
	const embed = createEmbed(result, page, language);
	const row = createButtons(page, result.length, language);

	return await interaction.editReply({
		embeds: [embed],
		components: [row],
		content: languageText("page", language, {
			page: page + 1,
			maxPage: Math.ceil(result.length / pageSize),
		}),
	});
}
