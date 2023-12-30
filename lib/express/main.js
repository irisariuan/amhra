const express = require('express')
const app = express()

app.get('/', (req, res) => {
    res.sendFile(process.cwd() + '/express/main.html')
})
app.get('/css', (req, res) => {
    res.sendFile(process.cwd() + '/express/compiled.css')
})

module.exports = { app }