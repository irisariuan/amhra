import { CustomClient } from "../custom";
import { languageText } from "../language";
import { globalApp, dcb } from "../misc";
import {
	createResource,
	getConnection,
	destroyAudioPlayer,
	timeFormat,
} from "../voice/core";
import { deleteSkipMessage, sendSkipMessage } from "../voice/segment";
import { SongEditType } from "./event";
import { SongEditRequest } from "./schema";

export async function handleSongInterruption(
	client: CustomClient,
	data: SongEditRequest,
): Promise<number> {
	const action = data.action;
	const guildId = data.guildId;
	const player = client.player.get(guildId);
	if (!player) {
		globalApp.err("Player not found");
		return 400;
	}
	switch (action) {
		case SongEditType.Pause: {
			player.pause();
			break;
		}
		case SongEditType.Resume: {
			player.unpause();
			break;
		}
		case SongEditType.SetTime: {
			if (!player.nowPlaying || !player.isPlaying) {
				globalApp.err(
					"Cannot interrupt the song since nothing is playing",
				);
				return 400;
			}
			if (
				data.detail.sec > player.nowPlaying.details.durationInSec ||
				data.detail.sec < 0
			) {
				globalApp.err("Out of range");
				return 400;
			}

			const res = await createResource(
				player.nowPlaying.url,
				data.detail.sec,
			);
			if (!res) {
				globalApp.err("Failed to create resource");
				return 500;
			}
			player.playResource(res, true);
			await sendSkipMessage(player);
			dcb.log("Relocated the video");
			break;
		}
		case SongEditType.AddSong: {
			dcb.log("Added song from dashboard to queue");
			player.addToQueue(data.detail.url);
			if (!player.isPlaying) {
				const nextUrl = player.getNextQueueItem();
				if (!nextUrl) return 400;
				const res = await createResource(
					nextUrl,
					data.detail.seek,
					data.detail.force,
				);
				if (!res) {
					globalApp.err("Failed to create resource");
					return 500;
				}

				player.playResource(res);
				dcb.log("Started playing song from queue");
			}
			break;
		}
		case SongEditType.Stop: {
			dcb.log("Stop the music from dashboard");
			player.cleanStop();
			break;
		}
		case SongEditType.Skip: {
			dcb.log("Skip the music from dashboard");
			player.stop();
			break;
		}
		case SongEditType.RemoveSong: {
			dcb.log("Removing song from dashboard");
			const removedSong = player.queue.splice(data.detail.index, 1);
			if (removedSong.at(0)) {
				dcb.log(`Removed song URL: ${removedSong[0]}`);
			} else {
				globalApp.err("Out of index");
				return 400;
			}
			break;
		}
		case SongEditType.SetVolume: {
			dcb.log(
				`Setting volume to ${data.detail.volume * 100}% from dashboard`,
			);
			player.setVolume(data.detail.volume);
			break;
		}
		case SongEditType.SetQueue: {
			dcb.log("Switching queue from dashboard");
			if (data.detail.queue) {
				player.queue = data.detail.queue;
			} else {
				globalApp.err("Queue error", data.detail.queue);
				return 400;
			}
			break;
		}
		case SongEditType.Quit: {
			dcb.log("Quitting from dashboard");
			player.stop();
			getConnection(guildId)?.destroy();
			destroyAudioPlayer(client, guildId);
			break;
		}
		case SongEditType.Unmute: {
			dcb.log("Unmuting from dashboard");
			player.unmute();
			break;
		}
		case SongEditType.Mute: {
			dcb.log("Muting from dashboard");
			player.mute();
			break;
		}
		case SongEditType.Loop: {
			dcb.log("Setting loop from dashboard");
			if (data.detail.loop) {
				dcb.log("Enabled loop");
				player.enableLoop();
			} else {
				dcb.log("Disabled loop");
				player.disableLoop();
			}
			break;
		}
		case SongEditType.SkipSegment: {
			const result = await player.skipCurrentSegment();
			if (result.success) {
				if (player.activeSkipMessage && result.skipTo) {
					await player.activeSkipMessage.edit({
						content: languageText(
							result.skipped
								? "segment_skip_next"
								: "segment_skip",
							player.currentLanguage,
							{ pos: timeFormat(result.skipTo.segment[1]) },
						),
						components: [],
					});
					for (const reaction of player.activeSkipMessage.reactions.cache.values()) {
						if (reaction.emoji.name === "✅") {
							await reaction.remove();
						}
					}
				}
				dcb.log("Skipped segment from dashboard");
			} else {
				globalApp.err("Failed to skip segment");
				return 500;
			}
			break;
		}
		default:
			return 400;
	}
	return 200;
}
