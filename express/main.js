let reg = false
let password = ""
const URL_REGEX =
	/(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})/

async function register() {
	password = document.querySelector("#auth").value
	document.querySelector("#auth").value = ""
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
			.forEach(v => document.querySelector("#log").appendChild(v))
	}
	setInterval(f, 10000)
	f()
	reg = true
}

async function editSong(action) {
	fetch("/api/song/edit", {
		body: JSON.stringify({
			action,
			guildId: document.querySelector("input#inpGuildId").value,
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
			guildId: document.querySelector("input#inpGuildId")?.value,
			detail: {
				sec: parseInt(document.querySelector("#songinp")?.value),
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
	const url = URL_REGEX.test(document.querySelector("#playinp")?.value)
		? URL_REGEX.exec(document.querySelector("#playinp")?.value)[0]
		: await (
				await fetch("/api/search", {
					body: JSON.stringify({
						query: document.querySelector("#playinp")?.value,
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
			guildId: document.querySelector("input#inpGuildId")?.value,
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
