import { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder, time, ComponentType, type Message, type ChatInputCommandInteraction } from "discord.js"
import type { TransformableResource } from "./voice/core";

export enum PageAction {
    PREVIOUS = 'prev',
    NEXT = 'next',
    REFRESH = 'refresh',
    FIRST = 'first',
    LAST = 'last'
}

export function createButtons(page: number, contentLength: number, maxPage: number = Math.ceil(contentLength / pageSize)) {
    const prevBtn = new ButtonBuilder()
        .setCustomId(PageAction.PREVIOUS)
        .setLabel('Previous Page')
        .setStyle(ButtonStyle.Primary)
    const nextBtn = new ButtonBuilder()
        .setCustomId(PageAction.NEXT)
        .setLabel('Next Page')
        .setStyle(ButtonStyle.Primary)
    const refreshBtn = new ButtonBuilder()
        .setCustomId(PageAction.REFRESH)
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Secondary)
    const firstBtn = new ButtonBuilder()
        .setCustomId(PageAction.FIRST)
        .setLabel('First Page')
        .setStyle(ButtonStyle.Secondary)
    const lastBtn = new ButtonBuilder()
        .setCustomId(PageAction.LAST)
        .setLabel('Last Page')
        .setStyle(ButtonStyle.Secondary)

    const row = new ActionRowBuilder<ButtonBuilder>()

    if (contentLength <= 0) {
        return row.addComponents(refreshBtn)
    }

    if (page <= 0) {
        prevBtn.setDisabled(true)
        firstBtn.setDisabled(true)
    }
    if (contentLength - (page + 1) * pageSize <= 0) {
        nextBtn.setDisabled(true)
        lastBtn.setDisabled(true)
    }
    row.addComponents(prevBtn, nextBtn, refreshBtn)
    if (maxPage > 1) {
        row.addComponents(firstBtn, lastBtn)
    }
    return row
}

export function getPage(page: number, maxPage: number, pageAction: PageAction) {
    return Math.max(Math.min(pageAction === PageAction.PREVIOUS ? page - 1 : pageAction === PageAction.NEXT ? page + 1 : pageAction === PageAction.FIRST ? 0 : pageAction === PageAction.LAST ? maxPage - 1 : page, maxPage - 1), 0)
}

export function createEmbed(result: TransformableResource[], page: number) {
    return new EmbedBuilder()
        .setTitle('Queue')
        .setTimestamp(Date.now())
        .setColor('Green')
        .addFields(...result
            .map(
                (v, i) => ({
                    name: `\\${i + page * pageSize + 1}\\ ${v.title}`,
                    value: [
                        `${v.url} (${v.details.durationInSec}s)`
                    ].join('\n')
                })
            )
            .slice(
                page * pageSize, (page + 1) * pageSize
            )
        )
        .setFooter({ text: `Showing songs ${page * pageSize + 1}-${Math.min((page + 1) * pageSize, result.length)} of ${result.length} (Total Length: ${result.length})` })
}

export const pageSize = 20

export async function sendPaginationMessage(getResult: () => Promise<TransformableResource[]>, interaction: ChatInputCommandInteraction, initalPage = 0) {
    const result = await getResult()
    let interactionResponse: Message
    let page = 0
    if (!result || result.length <= 0) {
        interactionResponse = await interaction.editReply({
            content: 'No songs found'.trim(),
            embeds: [],
            components: [createButtons(0, 0)]
        })
    } else {
        interactionResponse = await editInteraction(result, interaction, page)
    }

    interactionResponse.createMessageComponentCollector({ componentType: ComponentType.Button }).on('collect', async i => {
        i.deferUpdate()

        const reloadResult = i.customId === PageAction.REFRESH ? await getResult() : result

        if (!reloadResult || reloadResult.length <= 0) return interaction.editReply({
            content: 'No songs found'.trim(),
            embeds: [],
            components: [createButtons(0, 0)]
        })

        const maxPage = Math.ceil(reloadResult.length / pageSize)
        page = getPage(page, maxPage, i.customId as PageAction)

        if (!reloadResult) return await interaction.editReply({
            content: 'No songs found'.trim(),
            embeds: [],
            components: [createButtons(0, 0)]
        })

        editInteraction(reloadResult, interaction, page)
    })
}

async function editInteraction(result: TransformableResource[], interaction: ChatInputCommandInteraction, page: number) {
    const embed = createEmbed(result, page)
    const row = createButtons(page, result.length)

    return await interaction.editReply({ embeds: [embed], components: [row], content: `Page ${page + 1}/${Math.ceil(result.length / pageSize)}`.trim() })
}