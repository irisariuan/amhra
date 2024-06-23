import type { LogType } from "../log/load";
import type { SongEditType } from "./type";

const EventEmitter = require('node:events')

export type ExpressEventDetail = {
    url?: string
    sec?: number
    index?: number
    volume?: string
    queue?: string[]
    time?: number
}

export class ExpressEvent extends EventEmitter {
    on(event: 'globalAction', listener: (action: 'exit' | 'addAuth') => void | Promise<void>): this
    on(event: 'log', listener: (message: string, type: LogType) => void | Promise<void>): this
    on(event: 'action', listener: (action: string) => void | Promise<void>): this
    on(event: 'page', listener: (path: string) => void | Promise<void>): this
    on(event: 'songInterruption', listener: (<T extends SongEditType>(guildId: string, action: T, detail: ExpressEventDetail) => void | Promise<void>) | ((guildId: string, action: SongEditType) => void | Promise<void>)): this
    on(event: string, listener: (...any) => void | Promise<void>) {
        return super.on(event, listener)
    }
    emitSong<T extends SongEditType>(guildId: string, action: T, detail: ExpressEventDetail) {
        return super.emit('songInterruption', guildId, action, detail)
    }
    emitPage(path: string) {
        return super.emit('page', path)
    }
    emitAction(action: 'exit' | 'addAuth') {
        return super.emit('globalAction', action)
    }
    emitSongInfo(url: string) {
        return super.emit('songInfo', url)
    }
}

export const event = new ExpressEvent()