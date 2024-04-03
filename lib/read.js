const fs = require('node:fs')

function readJson(file, encoding='utf-8') {
	return new Promise((resolve, reject) => {
		fs.readFile(file, encoding, (err, data) => {
			if (err) {return reject(err)}
			resolve(JSON.parse(data))
		})
	})
}

function readJsonSync(file, encoding='utf-8') {
	return JSON.parse(fs.readFileSync(file, encoding))
}

function writeJsonSync(file, data) {
	return fs.writeFileSync(file, JSON.stringify(data, null, 4))
}

module.exports = { readJson, readJsonSync, writeJsonSync }
