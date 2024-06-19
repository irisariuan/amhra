import { readFile, writeFileSync, readFileSync } from 'node:fs'

export function readJson(file) {
	return new Promise((resolve, reject) => {
		readFile(file, 'utf8', (err, data) => {
			if (err) { return reject(err) }
			resolve(JSON.parse(data))
		})
	})
}

export function readJsonSync(file = `${process.cwd()}/data/setting.json`) {
	return JSON.parse(readFileSync(file, 'utf8'))
}

export function writeJsonSync(file, data) {
	return writeFileSync(file, JSON.stringify(data, null, 4))
}
