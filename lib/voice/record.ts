import { VoiceRecorder } from "@kirdock/discordjs-voice-recorder"
import { getConnection, joinVoice } from "./core"
import { createWriteStream } from "node:fs"

export const recordingList: Set<string> = new Set()
export const voiceRecorder = new VoiceRecorder({ maxRecordTimeMinutes: 20 })

/**
 * Start the record if the guild is not recording
 * Returns if the record is currently started
 */
export async function startRecord(interaction, autoJoin = true) {
	if (recordingList.has(interaction.guildId)) return false
	recordingList.add(interaction.guildId)
	//get voice connection, if there isn't one, create one
	let connection = getConnection(interaction.guildId)
	if (!connection) {
		if (!interaction.member.voice.channel || !autoJoin) return false
		// try to auto join the voice channel
		connection = joinVoice(interaction.member.voice.channel, interaction)
		// failed to join, return false
		if (!connection) {
			return false
		}
	}
	voiceRecorder.startRecording(connection)
	return true
}

export async function stopRecord(interaction) {
	recordingList.delete(interaction.guildId)
	const connection = getConnection(interaction.guildId)
	if (!connection) return false
	voiceRecorder.stopRecording(connection)
	return true
}

/**
 * Clear the recording status and save the recording into file
 */
export async function saveRecord(interaction, minutes, type: 'separate' | 'single' = 'separate') {
	recordingList.delete(interaction.guildId)
	const connection = getConnection(interaction.guildId)
	if (!connection) return false
	const fileStream = createWriteStream(`${process.cwd()}/data/recordings/${interaction.guildId}-${Date.now()}.${type === 'separate' ? 'zip' : 'mp3'}`)
	return await voiceRecorder.getRecordedVoice(fileStream, interaction.guildId, type, minutes)
	
}