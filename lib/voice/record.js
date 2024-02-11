const { getVoiceConnection, EndBehaviorType } = require("@discordjs/voice")
const fs = require("fs")
const prism = require("prism-media")
const { pipeline } = require("stream")
const { joinVoice } = require("./core")

async function record(interaction, opts = {}) {
	// return await interaction.reply({ content: 'Currently not supported!' })
	//get voice connection, if there isn't one, create one
	let connection = getVoiceConnection(interaction.guildId)
	if (!connection) {
		if (!interaction.member.voice.channel) return false
		connection = joinVoice(interaction.member.voice.channel, interaction)
	}
	const memberId = interaction.member.id

	//create the stream and setup events
	const stream = connection.receiver.subscribe(memberId, {
		end: {
			behavior: EndBehaviorType.Manual,
		},
	})
	stream.on("close", () => {
		console.log("Data Stream closed")
	})
	stream.on("error", e => {
		console.error(e)
	})
	//create the file stream
	const writableStream = fs.createWriteStream(
		`${opts.filename || interaction.guild.name}.${opts.format || "ogg"}`
	)
	console.log("Created the streams, started recording")
	//todo: set the stream into client and stop it in another function
	//now: record 5s
	return setTimeout(async () => {
		//stop the stream
		stream.destroy()
		await /** @type {Promise<void>} */ (
			new Promise(r => {
				stream.on("close", () => {
					r()
				})
			})
		)
		console.log("Stop recording")
		const oggWriter = new prism.opus.OggLogicalBitstream({
			opusHead: new prism.opus.OpusHead({
				channelCount: 2,
				sampleRate: 48000,
			}),
			pageSizeControl: {
				maxPackets: 10,
			},
		})

		try {
			pipeline(stream, oggWriter, writableStream, e => {
				console.error(e)
			})
		} catch (e) {
			console.error(e)
		}
		// ffmpeg()
		// .input(stream)
		// .inputFormat('opus')
		// .format('mp3')
		// .output(`${interaction.guild.name}.mp3`)
		// .on('close', () => {
		// console.log('Stream closed')
		// })
		// .on('error', (e) => {
		// console.error(e)
		// })
	}, 5000)
}

module.exports = { record }
