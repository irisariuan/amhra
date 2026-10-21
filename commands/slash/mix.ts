import { SlashCommandBuilder } from "discord.js";
import { type Command } from "../../lib/interaction";
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
	getMix,
	nativeRemoveLayer,
	nativeSetLayerVolume,
	nativeSetMainVolume,
	nativeVoiceActive,
} from "../../lib/voice/native";
import { addLayerFromInput } from "../../lib/voice/mix";

export default {
	data: new SlashCommandBuilder()
		.setName("mix")
		.setDescription("Play songs on top of the queue, each at its own volume")
		.addSubcommand((sub) =>
			sub
				.setName("add")
				.setDescription("Play a song alongside whatever is playing")
				.addStringOption((opt) =>
					opt
						.setName("search")
						.setDescription("A video link or a search on YouTube")
						.setRequired(true),
				)
				.addNumberOption((opt) =>
					opt
						.setName("volume")
						.setDescription("Its volume (0-500), 100 if left empty")
						.setMinValue(0)
						.setMaxValue(500),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName("remove")
				.setDescription("Stop a song that is mixed in")
				.addIntegerOption((opt) =>
					opt
						.setName("layer")
						.setDescription("The number shown by /mix list")
						.setMinValue(1)
						.setRequired(true),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName("volume")
				.setDescription("Set the volume of a song that is mixed in")
				.addIntegerOption((opt) =>
					opt
						.setName("layer")
						.setDescription("The number shown by /mix list")
						.setMinValue(1)
						.setRequired(true),
				)
				.addNumberOption((opt) =>
					opt
						.setName("volume")
						.setDescription("Its volume (0-500)")
						.setMinValue(0)
						.setMaxValue(500)
						.setRequired(true),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName("main")
				.setDescription("Set the volume of the queue's song within the mix")
				.addNumberOption((opt) =>
					opt
						.setName("volume")
						.setDescription("Its volume (0-500)")
						.setMinValue(0)
						.setMaxValue(500)
						.setRequired(true),
				),
		)
		.addSubcommand((sub) =>
			sub.setName("list").setDescription("Show what is mixed in"),
		),
	async execute({ interaction, client, language }) {
		if (!interaction.guild)
			return await interaction.reply({
				content: languageText("server_only_command", language),
			});
		// Mixing happens in the Rust sidecar; the discord.js path has one
		// stream per guild and nowhere to put a second.
		if (!nativeVoiceActive())
			return await interaction.reply({
				content: languageText("mix_native_only", language),
			});
		const guildId = interaction.guild.id;
		const subcommand = interaction.options.getSubcommand(true);
		const mix = getMix(guildId);

		if (subcommand === "list") {
			const lines = mix.list().map((layer, i) =>
				languageText("mix_list_item", language, {
					index: i + 1,
					title: layer.title,
					url: layer.url,
					volume: layer.volume,
				}),
			);
			return interaction.reply({
				content: [
					languageText("mix_main_volume", language, { volume: mix.mainVolume }),
					lines.length
						? languageText("mix_list_header", language)
						: languageText("mix_empty", language),
					...lines,
				].join("\n"),
				flags: ["SuppressEmbeds"],
			});
		}

		// Everything else changes what the channel hears, so the same voice
		// checks as /volume apply.
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

		if (subcommand === "add") {
			const input = interaction.options.getString("search", true);
			const volume = interaction.options.getNumber("volume") ?? 100;
			if (isPlaylist(input))
				return interaction.reply(languageText("mix_video_only", language));
			if (mix.isFull())
				return interaction.reply(languageText("mix_full", language));

			await interaction.deferReply();
			// Joined before the download, so the voice handshake and the
			// fetch overlap instead of queueing behind each other.
			const connection = ensureVoiceConnection(interaction);
			const player = getAudioPlayer(client, guildId, interaction.channel, language);
			if (!connection || !player)
				return interaction.editReply(misc.errorMessageObj(language));
			connection.subscribe(player);

			let url = input;
			if (!isVideo(input)) {
				const results = await searchYouTube(input);
				if (!results[0])
					return interaction.editReply(languageText("mix_not_found", language));
				url = results[0].url;
			}
			const result = await addLayerFromInput(guildId, url, volume);
			if ("error" in result) {
				return interaction.editReply(
					result.error === "full"
						? languageText("mix_full", language)
						: result.error === "not_found"
							? languageText("mix_not_found", language)
							: misc.errorMessageObj(language),
				);
			}
			dcb.log(`Mixed ${result.layer.url} into ${guildId} from /mix`);
			return interaction.editReply({
				content: languageText("mix_added", language, {
					title: result.layer.title,
					url: result.layer.url,
					volume: result.layer.volume,
				}),
				flags: ["SuppressEmbeds"],
			});
		}

		if (!getConnection(guildId))
			return interaction.reply({
				content: languageText("not_connected", language),
			});

		if (subcommand === "main") {
			const volume = interaction.options.getNumber("volume", true);
			nativeSetMainVolume(guildId, volume);
			return interaction.reply(languageText("mix_main_set", language, { volume }));
		}

		const index = interaction.options.getInteger("layer", true);
		const layer = mix.at(index);
		if (!layer)
			return interaction.reply(languageText("mix_no_layer", language, { index }));

		if (subcommand === "remove") {
			nativeRemoveLayer(guildId, layer);
			return interaction.reply({
				content: languageText("mix_removed", language, {
					title: layer.title,
					url: layer.url,
				}),
				flags: ["SuppressEmbeds"],
			});
		}

		// volume
		const volume = interaction.options.getNumber("volume", true);
		nativeSetLayerVolume(guildId, layer, volume);
		return interaction.reply({
			content: languageText("mix_volume_set", language, {
				title: layer.title,
				url: layer.url,
				volume,
			}),
			flags: ["SuppressEmbeds"],
		});
	},
} as Command<SlashCommandBuilder>;
