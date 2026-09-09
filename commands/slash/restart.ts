import type { Command } from "../../lib/interaction";

import { SlashCommandBuilder } from "discord.js";
import { getAccountByDiscordId } from "../../lib/auth/discord";
import { Permission, hasPermission } from "../../lib/db/account";
import { pendingRelease, requestApply, requestRestart } from "../../lib/deploy";
import { languageText } from "../../lib/language";
import { globalApp } from "../../lib/misc";

/**
 * Applies a staged release, or restarts in place.
 *
 * The deploy agent stages commits but never restarts the bot on its own, so
 * this is how a new version actually goes live. It is gated on the caller's
 * *account* being an admin, not on Discord server permissions: a guild owner is
 * not an operator of this bot, and the permission bit only exists on accounts.
 * That means the caller has to have linked Discord from the dashboard first.
 *
 * The process exits rather than reloading anything. scripts/deploy/run.sh — the
 * launchd entry point — does the swap while nothing is running and starts the
 * new version.
 */
export default {
	data: new SlashCommandBuilder()
		.setName("restart")
		.setDescription("Apply a staged update and restart the bot (admin only)")
		.addBooleanOption(option =>
			option
				.setName("force")
				.setDescription(
					"Restart on the current version even with nothing staged",
				),
		),
	async execute({ interaction, client, language }) {
		const account = await getAccountByDiscordId(interaction.user.id).catch(
			() => null,
		);
		if (!account) {
			return interaction.reply({
				content: languageText("restart_not_linked", language),
				ephemeral: true,
			});
		}
		if (!hasPermission(account, Permission.Admin)) {
			return interaction.reply({
				content: languageText("restart_not_admin", language),
				ephemeral: true,
			});
		}

		const force = interaction.options.getBoolean("force") ?? false;
		const pending = pendingRelease();
		if (!pending && !force) {
			return interaction.reply({
				content: languageText("restart_nothing_staged", language),
				ephemeral: true,
			});
		}

		// The admin asked for this, so it happens either way — but a restart cuts
		// off everyone listening, and the number of guilds it will cut off is the
		// one thing they cannot see from Discord.
		const playing = client.player.size;
		const applied = pending ? requestApply() : (requestRestart(), null);

		await interaction.reply({
			content: applied
				? languageText("restart_applying", language, {
						version: applied.sha.slice(0, 7),
						subject: applied.subject,
						playing,
					})
				: languageText("restart_in_place", language, { playing }),
			ephemeral: true,
		});

		globalApp.important(
			`Restart requested by account ${account.id} (Discord ${interaction.user.id})${
				applied ? `, applying ${applied.sha}` : ""
			}`,
		);
		// Long enough for the interaction response and the log write to leave the
		// process, short enough that the admin sees it as immediate.
		setTimeout(() => process.exit(0), 1000);
	},
} as Command<SlashCommandBuilder>;
