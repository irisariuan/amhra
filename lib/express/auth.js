const { exchangeCode } = require("../auth/core")
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
        await exchangeCode(req.body.code)
        console.log('ok')
        return res.sendStatus(200)
    })
}

module.exports = { initAuth }