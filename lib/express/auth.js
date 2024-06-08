const { exchangeCode, register } = require("../auth/core")
const Express = require('express')

/**
 * 
 * @param {Express.Express} app 
 */
function initAuth(app, jsonParser, basicCheckBuilder, setting) {
    app.post('/api/register', jsonParser, basicCheckBuilder(['code']), async (req, res) => {
        if (!req.body.code) {
            return res.sendStatus(400)
        }
        const result = await register(req.body.code)
        if (!result) {
            res.sendStatus(400)
        }

        return res.send(JSON.stringify({ token: result.accessToken }))
    })
}

module.exports = { initAuth }