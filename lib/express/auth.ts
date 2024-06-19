import { register } from "../auth/core"
import type Express from 'express'

export function initAuth(app: Express.Express, jsonParser, basicCheckBuilder) {
    app.post('/api/register', jsonParser, basicCheckBuilder(['code']), async (req, res) => {
        if (!req.body.code) {
            return res.sendStatus(400)
        }
        const result = await register(req.body.code)
        if (!result) {
            return res.sendStatus(400)
        }
        return res.send(JSON.stringify({ token: result.accessToken }))
    })
}