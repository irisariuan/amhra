const express = require("express")
const { rateLimit } = require("express-rate-limit")
const crypto = require("crypto")
const { search } = require("play-dl")
const { event } = require("./event")
const bodyParser = require("body-parser")
const {
	exp: { log, error },
	globalApp,
	misc,
	exp,
} = require("../misc")
const { readJsonSync } = require("../read")
const { data } = require("../../commands/currentQueue")
const chalk = require("chalk")
const app = express()

app.use((req, res, next) => {
	const formatter = misc.prefixFormatter(`${chalk.bgGrey(`(IP: ${req.ip})`)}`)

	event.emit("page", req.path)
	if (setting?.DETAIL_LOGGING) {
		exp.log(formatter(`Requested page ${req.path}`))
	}
	next()
})

const jsonParser = bodyParser.json()
const setting = readJsonSync(process.cwd() + "/data/setting.json")
function auth(req, res, next) {
	const formatter = misc.prefixFormatter(`${chalk.bgGrey(`(IP: ${req.ip})`)}`)
	if (!req.headers.authorization) {
		error(formatter("Auth failed"))
		return res.sendStatus(401)
	}

	const auth = Buffer.from(req.headers.authorization, "utf8")
	const hashed = crypto.createHash("sha256").update(auth).digest("hex")
	if (hashed !== setting.AUTH_TOKEN) {
		error(formatter("Auth failed"))
		console.log(req.headers.authorization, hashed, setting.AUTH_TOKEN)
		return res.sendStatus(401)
	}
	next()
}

function registered(req, res, next) {
	if (queueNo.has(req.ip)) {
		return next()
	}
	error(`${chalk.bgGrey(`(IP: ${req.ip})`)}` + " IP not yet registered")
	res.sendStatus(401)
}

if (setting.ENABLE_RATE_LIMIT) {
	app.use(
		rateLimit({
			windowMs: 5 * 60 * 1000,
			limit: 5 * 20,
			standardHeaders: "draft-7",
			legacyHeaders: false,
		})
	)
} else {
	globalApp.warn("API rate limit disabled")
}

/**
 * @param {string[]} checklist
 */
function basicCheckBuilder(checklist) {
	/**
	 * @param {Request} req
	 * @param {Response} res
	 */
	return function (req, res, next) {
		for (const i of checklist) {
			if (!(i in req.body)) {
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

const logQueue = []
let queueNo = new Map()

event.on("log", (msg, type) => {
	if (type.startsWith("exp") && !setting.DETAIL_LOGGING) {
		return
	}
	if (logQueue.length >= setting.QUEUE_SIZE) {
		logQueue.splice(0, logQueue.length - setting.QUEUE_SIZE)
	}
	logQueue.push({ message: msg, type, time: Date.now() })
})

event.on("page", (pageName) => exp.log("Fetched page " + pageName))

app.get("/api/new", auth, (req, res) => {
	if (queueNo.has(req.ip)) {
		return res.sendStatus(205)
	}
	log("New IP registered: " + req.ip)
	queueNo.set(req.ip, 0)
	res.sendStatus(200)
})

app.get("/api/log", auth, registered, (req, res) => {
	res.send(JSON.stringify({ content: logQueue }))
	queueNo.set(req.ip, logQueue.length)
})

app.post(
	"/api/song/edit",
	jsonParser,
	auth,
	registered,
	basicCheckBuilder(["action", "guildId"]),
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
				cLog(`Pausing song from dashboard`)
				event.emit("songInterruption", req.body.guildId, req.body.action)
				break
			case "resume":
				cLog(`Resuming song from dashboard`)
				event.emit("songInterruption", req.body.guildId, req.body.action)
				break
			case "setTime":
				if (req.body.detail?.sec) {
					cLog(`Setting time`)
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
					cLog(`Received song from dashboard`)
					event.emit(
						"songInterruption",
						req.body.guildId,
						req.body.action,
						req.body.detail
					)
				} else {
					cError(`URL not found`)
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
			default:
				cError("Invalid action: " + req.body.action)
				return res.sendStatus(400)
		}
		return res.sendStatus(200)
	}
)

app.get("/api/song/get/:guildId", auth, registered, async (req, res) => {
	event.emit("songDataRequest", req.params.guildId)
	const data = await new Promise((r) => {
		event.once("songDataReply", (data) => {
			r(data)
		})
	})
	return res.send(JSON.stringify(data))
})

app.post(
	"/api/action",
	jsonParser,
	auth,
	registered,
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
			case "monitor": {
				if (!("status" in req.body)) {
					return res.sendStatus(400)
				}
				globalApp.warn("Monitor function not yet implemented")
				res.sendStatus(501)
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
	auth,
	registered,
	basicCheckBuilder(["query"]),
	async (req, res) => {
		if (!req.body.query) {
			return res.sendStatus(400)
		}
		log("Queried " + req.body.query)
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

app.get("/api/live", auth, registered, async (req, res) => {
	return res.sendStatus(200)
})

app.get("/api/logout", auth, registered, async (req, res) => {
	log(`${req.ip} just logout`)
	queueNo.delete(req.ip)
	res.sendStatus(200)
})

// GET /api/guildIds endpoint in lib/client.js

module.exports = { app, registered }
