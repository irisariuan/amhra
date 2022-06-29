const fs = require('fs')

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

module.exports = { readJson, readJsonSync }
