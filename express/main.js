let reg = false
let password = ""
const URL_REGEX =
	/(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})/

async function register() {
	const auth = document.querySelector("input#auth")
	if (!auth) return
	password = auth.value
	auth.value = ""
	if (!(await (await fetch("/api/new")).ok)) return
	if (reg) return
	const f = async () => {
		const logMsg = await (
			await fetch("/api/log", {
				headers: { Authorization: "Basic " + password },
			})
		).json()
		if (!logMsg) {
			return
		}
		console.log(logMsg)
		logMsg.content
			.map(v => {
				const l = document.createElement("li")
				if (v.type === "err") {
					l.className = "text-red-400"
				}
				l.textContent = v.message
				return l
			})
			.forEach(v => document.querySelector("ul#log")?.appendChild(v))
		/**
		 * @type {string[]}
		 */
		const guildId = (await getGuildIds()).ids
		const selected = document.querySelector("select#guildSelected")
		if (!selected?.childNodes || !selected) return

		if (guildId.length === 0) {
			const opt = document.createElement("option")
			opt.value = ""
			opt.text = "No Guild Found"
			document
				.querySelector("select#guildSelected")
				?.setAttribute("disabled", "")
			document.querySelector("select#guildSelected")?.appendChild(opt)
		}
		console.log(guildId)
		for (const i of selected.childNodes) {
			if (!i.value) {
				continue
			}
			if (guildId.includes(i.value)) {
				guildId.splice(guildId.indexOf(i.value), 1)
			} else {
				selected.removeChild(i)
			}
		}
		console.log(guildId)
		for (const i of guildId) {
			const opt = document.createElement("option")
			opt.value = i
			opt.text = i
			document
				.querySelector("select#guildSelected")
				?.removeAttribute("disabled")
			document.querySelector("select#guildSelected")?.appendChild(opt)
		}
	}
	setInterval(f, 10000)
	f()
	reg = true
}

async function editSong(action) {
	fetch("/api/song/edit", {
		body: JSON.stringify({
			action,
			guildId: document.querySelector("select#guildId").value,
		}),
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Basic " + password,
		},
	})
}

async function editSec() {
	fetch("/api/song/edit", {
		body: JSON.stringify({
			action: "setTime",
			guildId: document.querySelector("select#guildId")?.value,
			detail: {
				sec: parseInt(document.querySelector("input#songinp")?.value),
			},
		}),
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Basic " + password,
		},
	})
}

async function addToQueue() {
	const url = URL_REGEX.test(document.querySelector("input#playinp")?.value)
		? URL_REGEX.exec(document.querySelector("input#playinp")?.value)[0]
		: await (
				await fetch("/api/search", {
					body: JSON.stringify({
						query: document.querySelector("input#playinp")?.value,
					}),
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: "Basic " + password,
					},
				})
		  ).json().url

	fetch("/api/song/edit", {
		body: JSON.stringify({
			action: "addSong",
			guildId: document.querySelector("select#guildId")?.value,
			detail: {
				url,
			},
		}),
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Basic " + password,
		},
	})
}

async function action() {
	fetch("/api/action", {
		body: JSON.stringify({
			action: "exit",
		}),
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Basic " + password,
		},
	})
}

/**
 *
 * @param {boolean} enable
 */
async function monitor(enable) {
	fetch("/api/action", {
		body: JSON.stringify({
			action: "monitor",
			status: enable,
		}),
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Basic " + password,
		},
	})
}
async function getGuildIds() {
	return await (
		await fetch("/api/guildIds", {
			headers: {
				"Content-Type": "application/json",
				Authorization: "Basic " + password,
			},
		})
	).json()
}
