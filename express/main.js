window.onload = async () => {
    await fetch('/api/new')
    const f = async () => {
        const logMsg = await (await fetch('/api/log')).json()
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
}