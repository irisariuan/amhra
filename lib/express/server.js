const express = require("express")
const { rateLimit } = require("express-rate-limit")
const crypto = require("node:crypto")
const { load } = require("../log/load")
const { search, video_info } = require("play-dl")
const { event } = require("./event")
const bodyParser = require("body-parser")
const {
	exp: { log, error },
	globalApp,
	misc,
	exp,
	dcb,
} = require("../misc")
const { readJsonSync } = require("../read")
const chalk = require("chalk")
const { CustomClient } = require("../custom")
const NodeCache = require("node-cache")

const YoutubeVideoRegex = /http(?:s?):\/\/(?:www\.)?youtu(?:be\.com\/watch\?v=|\.be\/)([\w\-_]*)(&(amp;)?[\w?=]*)?/

/**
 * 
 * @param {CustomClient} client 
 * @returns {express.Express}>
 */
async function init(client) {
	function auth(protective = true) {
		return (req, res, next) => {
			const formatter = misc.prefixFormatter(`${chalk.bgGrey(`(IP: ${req.ip})`)}`)
			if (!req.headers.authorization) {
				error(formatter("Auth failed (NOT_FOUND)"))
				return res.sendStatus(401)
			}
			if (!protective && !req.headers.authorization.startsWith('Basic')) {
				return next()
			}
			const auth = Buffer.from(req.headers.authorization, "utf8")
			const hashed = crypto.createHash("sha256").update(auth).digest("hex")
			if (hashed !== setting.AUTH_TOKEN || authLevel.has(hashed)) {
				error(formatter("Auth failed (NOT_MATCHING)"))
				return res.sendStatus(401)
			}
			next()
		}
	}

	/**
	 * @param {string[]} checklist
	 */
	function basicCheckBuilder(checklist) {
		/**
		 * @param {Request} req
		 * @param {Response} res
		 */
		return (req, res, next) => {
			for (const i of checklist) {
				if (!(i in (req.body ?? []))) {
					error(
						`Missing '${i}' from requesting ${req.path} (Body: ${JSON.stringify(
							req.body
						)})`
					)
					return res.sendStatus(400)
				}
			}
			next()
		}
	}

	/**
	 * 
	 * @param {Request} req 
	 * @param {Response} res 
	 * @param {() => void} next 
	 */
	function checkGuildMiddleware(req, res, next) {
		if (checkGuild(req.headers.authorization ?? '', req.body.guildId)) {
			return next()
		}
		exp.error('Guild not found')
		res.sendStatus(401)
	}

	function checkGuild(auth, guildId = '') {
		if (auth.startsWith('Basic') || client.levelMap.get(auth)?.guilds?.includes(guildId)) {
			return true
		}
		return false
	}

	const app = express()
	const jsonParser = bodyParser.json()
	const setting = readJsonSync(`${process.cwd()}/data/setting.json`)
	
	const logQueue = await load(...setting.PRELOAD ?? [])
	// TTL set to 5 days
	const videoCache = new NodeCache({ stdTTL: 60 * 60 * 24 * 5 })
	/**
	 * @type {Map<string, {guilds: string[], level: number}>}
	 */
	const authLevel = new Map()

	app.use((req, res, next) => {
		const formatter = misc.prefixFormatter(`${chalk.bgGrey(`(IP: ${req.ip})`)}`)

		event.emit('page', req.path)
		if (setting?.DETAIL_LOGGING) {
			exp.log(formatter(`Requested page ${req.path}`))
		}
		next()
	})

	if (setting.RATE_LIMIT > 0) {
		app.use(
			rateLimit({
				windowMs: 5 * 60 * 1000,
				limit: setting.RATE_LIMIT,
				standardHeaders: 'draft-7',
				legacyHeaders: false,
			})
		)
		app.set('trust proxy', 1)
	} else {
		globalApp.warn('API rate limit disabled')
	}

	event.on('log', (msg, type) => {
		if (type.startsWith('exp') && !setting.DETAIL_LOGGING) {
			return
		}
		if (logQueue.length >= setting.QUEUE_SIZE) {
			logQueue.splice(0, logQueue.length - setting.QUEUE_SIZE)
		}
		logQueue.push({ message: msg, type, time: Date.now() })
	})

	event.on('page', (pageName) => exp.log(`Fetched page ${pageName}`))

	event.on('action', (action) => exp.log(`Received action: ${action}`))

	app.get("/api/new", auth(), (req, res) => {
		log(`New IP fetched: ${req.ip}`)
		res.sendStatus(200)
	})

	app.get("/api/log", auth(), (req, res) => {
		res.send(JSON.stringify({ content: logQueue }))
	})

	app.post(
		"/api/song/edit",
		jsonParser,
		auth(false),
		basicCheckBuilder(["action", "guildId"]),
		checkGuildMiddleware,
		(req, res) => {
			const formatter = misc.prefixFormatter(
				chalk.bgGrey(`(Guild ID: ${req.body.guildId}, IP: ${req.ip})`)
			)
			const cLog = (...data) => {
				log(formatter(data.join()))
			}
			const cError = (...data) => {
				error(formatter(data.join()))
			}
			switch (req.body.action) {
				case "pause":
					cLog('Pausing song from dashboard')
					event.emit("songInterruption", req.body.guildId, req.body.action)
					break
				case "resume":
					cLog('Resuming song from dashboard')
					event.emit("songInterruption", req.body.guildId, req.body.action)
					break
				case "setTime":
					if (req.body.detail?.sec) {
						cLog('Setting time')
						event.emit(
							"songInterruption",
							req.body.guildId,
							req.body.action,
							req.body.detail
						)
					} else {
						cError("Request body error")
						return res.sendStatus(400)
					}
					break
				case "addSong":
					if (req.body?.detail?.url) {
						cLog('Received song from dashboard')
						event.emit(
							"songInterruption",
							req.body.guildId,
							req.body.action,
							req.body.detail
						)
					} else {
						cError('URL not found')
						return res.sendStatus(400)
					}
					break
				case "stop":
					cLog(`(Guild ID: ${req.body.guildId}) Stopping song from dashboard`)
					event.emit("songInterruption", req.body.guildId, req.body.action)
					break
				case "skip":
					cLog("Skipping song from dashboard")
					event.emit("songInterruption", req.body.guildId, req.body.action)
					break
				case 'removeSong': {
					cLog('Removing song from dashboard')
					event.emit('songInterruption', req.body.guildId, req.body.action, req.body.detail)
					break
				}
				case 'setVolume': {
					cLog('Setting volume from dashboard')
					event.emit('songInterruption', req.body.guildId, req.body.action, req.body.detail)
					break
				}
				case 'setQueue': {
					cLog('Setting queue from dashboard')
					event.emit('songInterruption', req.body.guildId, req.body.action, req.body.detail)
					break
				}
				default:
					cError(`Invalid action: ${req.body.action}`)
					return res.sendStatus(400)
			}
			return res.sendStatus(200)
		}
	)

	app.post(
		"/api/action",
		jsonParser,
		auth(),
		basicCheckBuilder(["action"]),
		(req, res) => {
			const formatter = misc.prefixFormatter(`${chalk.bgGrey(`(IP: ${req.ip})`)}`)

			log(formatter("Received action request"))
			event.emit("globalAction", req.body.action)
			switch (req.body.action) {
				case "exit": {
					globalApp.important(formatter("Received exit request, exiting..."))
					process.exit(0)
					break
				}
				case "addAuth": {
					globalApp.important(formatter("Creating server-based dashboard"))
					if (!req.body.guildId) {
						globalApp.warn('Failed to create server-based dashboard, missing guild ID')
						return res.sendStatus(400)
					}
					const guildId = req.body.guildId
					const { token, level } = client.newToken([guildId])
					exp.log('Successfully created server-based dashboard')
					res.send(JSON.stringify({ token, guildId, level }))
					break
				}
				default: {
					log(`Action not recognized (${req.body.action})`)
				}
			}
		}
	)

	app.post(
		"/api/search",
		jsonParser,
		auth(false),
		basicCheckBuilder(["query"]),
		async (req, res) => {
			if (!req.body.query) {
				return res.sendStatus(400)
			}
			log(`Queried ${req.body.query}`)
			const searched = (await search(req.body.query, { limit: 1 }))[0]
			log(
				`Returned searched URL: ${searched.url}, title: ${searched.title} and durationInSec: ${searched.durationInSec}`
			)
			return res.send(
				JSON.stringify({
					url: searched.url,
					title: searched.title,
					durationInSec: searched.durationInSec,
				})
			)
		}
	)

	app.post('/api/getVideoDetail', jsonParser, auth(false), basicCheckBuilder(['url']), async (req, res) => {
		if (!req.body.url || !YoutubeVideoRegex.test(req.body.url)) {
			return res.sendStatus(400)
		}
		try {
			if (videoCache.has(req.body.url)) {
				return res.send(JSON.stringify(videoCache.get(req.body.url)))
			}
			const video = await (await video_info(req.body.url)).video_details
			videoCache.set(req.body.url, video)
			if (!video) {
				return res.sendStatus(404)
			}
			return res.send(JSON.stringify(video.toJSON()))
		} catch {
			res.sendStatus(500)
		}
	})

	app.post("/api/live", jsonParser, basicCheckBuilder(['guildId']), checkGuildMiddleware, async (req, res) => {
		exp.log('Live!')
		return res.sendStatus(200)
	})

	app.get("/api/logout", auth(), async (req, res) => {
		log(`${req.ip} just logout`)
		res.sendStatus(200)
	})

	app.get("/api/playingGuildIds", async (req, res) => {
		const content = await Promise.all(Array.from(client.player.keys()).map(async v => { return { id: v, name: (await client.guilds.fetch(v)).name ?? null } }))
		exp.log('Sent guild IDs')
		res.send(JSON.stringify({ content }))
	})
	app.get("/api/guildIds", async (req, res) => {
		const content = (await client.guilds.fetch()).map(v => { return { id: v.id, name: v.name } })
		exp.log('Sent guild IDs')
		res.send(JSON.stringify({ content }))
	})

	app.get('/api/messages/:guildId', auth(), async (req, res) => {
		if (!(await client.guilds.fetch()).has(req.params.guildId)) {
			exp.error('Guild not found')
			return res.sendStatus(404)
		}

		const guild = await client.guilds.fetch(req.params.guildId)
		const channels = await guild.channels.fetch()
		const data = channels.map(async v => {
			if (!v) return []
			const message = (await v.messages?.fetch({ force: true, cache: false })) ?? []

			const messages = message.map(v => { return { message: { content: v.content, id: v.id }, author: { id: v.author.id, tag: v.author.tag }, timestamp: { createdAt: v.createdTimestamp, ...(v.editedTimestamp ? { editedAt: v.editedTimestamp } : {}) } } })

			return { channel: { id: v.id, name: v.name }, messages }
		})
		return res.send(JSON.stringify({ content: await Promise.all(data) }))
	})

	app.get("/api/song/get/:guildId", auth(false), (req, res) => {
		if (!checkGuild(req.headers.authorization ?? '', req.params.guildId)) {
			return res.sendStatus(401)
		}
		const data = client.player.get(req.params.guildId)?.getData()
		return res.send(JSON.stringify(data ?? null))
	})

	return app
}

module.exports = { init }
