import express, { type Request, type NextFunction, type Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import crypto from 'node:crypto'
import { load } from '../log/load'
import { search, video_info } from 'play-dl'
import { initAuth } from './auth'
import { event } from './event'
import youtubeSuggest from 'youtube-suggest'
import bodyParser from 'body-parser'
import {
	globalApp,
	misc,
	exp
} from '../misc'
import { readJsonSync } from '../read'
import chalk from 'chalk'
import type { CustomClient } from '../custom'
import NodeCache from 'node-cache'
import { countUser, getUser } from '../db/core'
import { type Guild, getUserGuilds } from '../auth/core'
import type { TextChannel } from 'discord.js'
import { SongEditType } from '../express/event'

const YoutubeVideoRegex = /http(?:s?):\/\/(?:www\.)?youtu(?:be\.com\/watch\?v=|\.be\/)([\w\-_]*)(&(amp;)?[\w?=]*)?/

interface AuthOptions {
	requirePassword: boolean
	allowBearer: boolean
}

export async function init(client: CustomClient) {
	function auth(authOptions: AuthOptions = { requirePassword: true, allowBearer: false }) {
		return async (req: Request, res: Response, next: NextFunction) => {
			const formatter = misc.prefixFormatter(`${chalk.bgGrey(`(IP: ${req.ip})`)}`)
			if (!req.headers.authorization) {
				exp.error(formatter('Auth failed (NOT_FOUND)'))
				return res.sendStatus(401)
			}
			if (authOptions.allowBearer && req.headers.authorization.startsWith('Bearer')) {
				if (await countUser(misc.removeBearer(req.headers.authorization)) > 0) {
					return next()
				}
				exp.error(formatter('Auth failed (NOT_MATCHING_DB)'))
			}
			if (authOptions.requirePassword || req.headers.authorization.startsWith('Basic')) {
				if (!req.headers.authorization.startsWith('Basic')) {
					return res.sendStatus(401)
				}
				const auth = Buffer.from(req.headers.authorization, 'utf8')
				const hashed = crypto.createHash('sha256').update(auth).digest('hex')
				if (hashed === setting.AUTH_TOKEN || authLevel.has(hashed)) {
					return next()
				}
				exp.error(formatter('Auth failed (NOT_MATCHING)'))
			}
			if (!authOptions.requirePassword && !req.headers.authorization.startsWith('Basic') && !req.headers.authorization.startsWith('Bearer')) {
				return next()
			}
			return res.sendStatus(401)
		}
	}

	function basicCheckBuilder(checklist: string[]) {
		return (req: Request, res: Response, next: NextFunction) => {
			for (const i of checklist) {
				if (!(i in (req.body ?? []))) {
					exp.error(
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

	function checkGuildMiddleware(req: Request, res: Response, next: NextFunction) {
		if (checkGuild(req.headers.authorization ?? '', req.body?.guildId)) {
			return next()
		}
		exp.error('Guild not found')
		res.sendStatus(401)
	}

	function checkGuild(auth: string, guildId = '') {
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
	const userGuildCache = new NodeCache({ stdTTL: 60 * 60 * 3 })

	const authLevel: Map<string, { guilds: string[], level: number }> = new Map()

	app.use((req, res, next) => {
		const formatter = misc.prefixFormatter(`${chalk.bgGrey(`(IP: ${req.ip})`)}`)

		event.emitPage(req.path)
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

	app.get('/api/new', auth({ allowBearer: true, requirePassword: true }), (req, res) => {
		exp.log(`New IP fetched: ${req.ip}`)
		res.sendStatus(200)
	})

	app.get('/api/log', auth(), (req, res) => {
		res.send(JSON.stringify({ content: logQueue }))
	})

	app.post(
		'/api/song/edit',
		jsonParser,
		auth({ requirePassword: false, allowBearer: true }),
		basicCheckBuilder(['action', 'guildId']),
		checkGuildMiddleware,
		(req, res) => {
			const formatter = misc.prefixFormatter(
				chalk.bgGrey(`(Guild ID: ${req.body.guildId}, IP: ${req.ip})`)
			)
			const cLog = (...data) => {
				exp.log(formatter(data.join()))
			}
			const cError = (...data) => {
				exp.error(formatter(data.join()))
			}
			const action: SongEditType = req.body.action
			switch (action) {
				case SongEditType.Pause:
					cLog('Pausing song from dashboard')
					event.emitSong(req.body.guildId, action, {})
					break
				case SongEditType.Resume:
					cLog('Resuming song from dashboard')
					event.emitSong(req.body.guildId, action, {})
					break
				case SongEditType.SetTime:
					if (!setting.SEEK) {
						cError('Seeking is disabled')
						return res.sendStatus(500)
					}
					if (req.body.detail?.sec) {
						cLog('Setting time')
						event.emitSong(
							req.body.guildId,
							action,
							req.body.detail
						)
					} else {
						cError('Request body error')
						return res.sendStatus(400)
					}
					break
				case SongEditType.AddSong:
					if (req.body?.detail?.url) {
						cLog('Received song from dashboard')
						event.emitSong(
							req.body.guildId,
							action,
							req.body.detail
						)
					} else {
						cError('URL not found')
						return res.sendStatus(400)
					}
					break
				case SongEditType.Stop:
					cLog(`(Guild ID: ${req.body.guildId}) Stopping song from dashboard`)
					event.emitSong(req.body.guildId, action, {})
					break
				case SongEditType.Skip:
					cLog('Skipping song from dashboard')
					event.emitSong(req.body.guildId, action, {})
					break
				case SongEditType.RemoveSong: {
					cLog('Removing song from dashboard')
					event.emitSong(req.body.guildId, action, req.body.detail)
					break
				}
				case SongEditType.SetVolume: {
					cLog('Setting volume from dashboard')
					const volume = Number.isNaN(req.body.detail) || req.body.detail > 2 ? 0 : req.body.detail
					event.emitSong(req.body.guildId, action, volume)
					break
				}
				case SongEditType.SetQueue: {
					cLog('Setting queue from dashboard')
					event.emitSong(req.body.guildId, action, req.body.detail)
					break
				}
				case SongEditType.Quit: {
					cLog('Quitting from dashboard')
					event.emitSong(req.body.guildId, action, {})
					break
				}
				default:
					cError(`Invalid action: ${action}`)
					return res.sendStatus(400)
			}
			return res.sendStatus(200)
		}
	)

	app.post(
		'/api/action',
		jsonParser,
		auth(),
		basicCheckBuilder(['action']),
		(req, res) => {
			const formatter = misc.prefixFormatter(`${chalk.bgGrey(`(IP: ${req.ip})`)}`)

			exp.log(formatter('Received action request'))
			event.emitAction(req.body.action)
			switch (req.body.action) {
				case 'exit': {
					globalApp.important(formatter('Received exit request, exiting...'))
					process.exit(0)
					break
				}
				case 'addAuth': {
					globalApp.important(formatter('Creating server-based dashboard'))
					if (!req.body.guildId) {
						globalApp.warn('Failed to create server-based dashboard, missing guild ID')
						return res.sendStatus(400)
					}
					const guildId = req.body.guildId
					const { token, level } = client.newToken(guildId)
					exp.log('Successfully created server-based dashboard')
					res.send(JSON.stringify({ token, guildId, level }))
					break
				}
				default: {
					exp.log(`Action not recognized (${req.body.action})`)
				}
			}
		}
	)

	app.post(
		'/api/search',
		jsonParser,
		auth({ requirePassword: false, allowBearer: true }),
		basicCheckBuilder(['query']),
		async (req, res) => {
			if (!req.body.query) {
				return res.sendStatus(400)
			}
			exp.log(`Queried ${req.body.query}`)
			const searched = (await search(req.body.query, { limit: 1 }))[0]
			exp.log(
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

	app.post('/api/getVideoDetail', jsonParser, auth({ requirePassword: false, allowBearer: true }), basicCheckBuilder(['url']), async (req, res) => {
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

	app.post('/api/videoSuggestion', jsonParser, auth({ requirePassword: false, allowBearer: true }), basicCheckBuilder(['query']), async (req, res) => {
		const query = req.body.query ?? null
		if (!query) {
			return res.sendStatus(400)
		}
		const suggestion = await youtubeSuggest(query, { locale: 'zh' })
		return res.send(JSON.stringify({ content: suggestion }))
	})

	app.post('/api/live', jsonParser, basicCheckBuilder(['guildId']), checkGuildMiddleware, async (req, res) => {
		exp.log('Live!')
		return res.sendStatus(200)
	})

	app.get('/api/logout', auth({ requirePassword: true, allowBearer: true }), async (req, res) => {
		exp.log(`${req.ip} just logout`)
		res.sendStatus(200)
	})

	app.get('/api/playingGuildIds', auth({ requirePassword: false, allowBearer: true }), async (req, res) => {
		const content = await Promise.all(Array.from(client.player.keys()).map(async v => { return { id: v, name: (await client.guilds.fetch(v)).name ?? null } }))
		if (req.headers.authorization?.startsWith('Bearer')) {
			const user = await getUser(misc.removeBearer(req.headers.authorization))
			if (!user) {
				return res.sendStatus(401)
			}
			let rawGuilds: Guild[]
			if (userGuildCache.has(user.id)) {
				rawGuilds = userGuildCache.get(user.id) as Guild[]
			} else {
				rawGuilds = await getUserGuilds(misc.removeBearer(req.headers.authorization)) ?? []
				userGuildCache.set(user.id, rawGuilds)
			}
			const guilds = rawGuilds.map(v => v.id)
			client.levelMap.set(req.headers.authorization, { guilds, level: 0 })
			if (!guilds) {
				return res.sendStatus(401)
			}
			return res.send(JSON.stringify({ content: content.filter(v => guilds.includes(v.id)) }))
		}
		exp.log('Sent guild IDs')
		res.send(JSON.stringify({ content }))
	})
	app.get('/api/guildIds', async (req, res) => {
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
			const message = (await (v as TextChannel).messages?.fetch({ cache: true })) ?? []

			const messages: Message[] = message.map(v => {
				return {
					message: { content: v.content, id: v.id },
					author: { id: v.author.id, tag: v.author.tag },
					timestamp: {
						createdAt: v.createdTimestamp,
						editedAt: v.editedTimestamp ?? undefined
					}
				}
			})

			return { channel: { id: v.id, name: v.name }, messages }
		})
		return res.send(JSON.stringify({ content: await Promise.all(data) }))
	})

	app.get('/api/song/get/:guildId', auth({ requirePassword: false, allowBearer: true }), (req, res) => {
		if (!checkGuild(req.headers.authorization ?? '', req.params.guildId)) {
			return res.sendStatus(401)
		}
		const data = client.player.get(req.params.guildId)?.getData()
		return res.send(JSON.stringify(data ?? null))
	})

	initAuth(app, jsonParser, basicCheckBuilder)

	return app
}

export interface Message {
	message: {
		content: string
		id: string
	},
	author: {
		id: string
		tag: string
	},
	timestamp: {
		createdAt: number
		editedAt?: number
	}
}