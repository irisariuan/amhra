import { writeFileSync, readFileSync } from 'node:fs'
import type { Setting } from './setting'

let setting: Setting | null = null

export function readJsonSync(file = `${process.cwd()}/data/setting.json`): Setting {
	if (setting === null) {
		setting = JSON.parse(readFileSync(file, 'utf8'))
	}
	return setting ?? JSON.parse(readFileSync(file, 'utf8'))
}

export function reloadSetting(file = `${process.cwd()}/data/setting.json`) {
	setting = JSON.parse(readFileSync(file, 'utf8'))
	return setting
}

export function writeJsonSync(file: string, data: Setting) {
	return writeFileSync(file, JSON.stringify(data, null, 4))
}
