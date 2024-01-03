let reg = false
let password = ''

async function register() {
    password = document.querySelector('#auth').value
    document.querySelector('#auth').value = ''
    await fetch('/api/new')
    if (reg) return
    const f = async () => {
        const logMsg = await (await fetch('/api/log', { headers: { Authorization: 'Basic ' + password } })).json()
        if (!logMsg) {
            return
        }
        console.log(logMsg)
        logMsg.content.map(v => {
            const l = document.createElement('li')
            if (v.type === 'err') {
                l.className = 'text-red-400'
            }
            l.textContent = v.message
            return l
        }).forEach(v => document.querySelector('#log').appendChild(v))
    }
    setInterval(f, 10000);
    f()
    reg = true
}

async function editSong(action) {
    fetch('/api/song/edit', {
        body: JSON.stringify({ action, guildId: document.querySelector('input#inpGuildId').value }),
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + password
        }
    })
}

async function editSec() {
    fetch('/api/song/edit', {
        body: JSON.stringify({
            action: 'setTime', guildId: document.querySelector('input#inpGuildId').value, detail: {
                sec: parseInt(document.querySelector('#songinp').value)
            }
        }),
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + password
        }
    })
}

async function addToQueue() {
    const w = await (await fetch('/api/search', {
        body: JSON.stringify({
            query: document.querySelector('#playinp').value
        }),
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + password
        }
    })).json()
    fetch('/api/song/edit', {
        body: JSON.stringify({
            action: 'addSong',
            guildId: document.querySelector('input#inpGuildId').value,
            detail: {
                url: w.url
            }
        }),
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + password
        }
    })
}

async function action() {
    fetch('/api/action', {
        body: JSON.stringify({
            action: 'exit'
        }),
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + password
        }
    })
}