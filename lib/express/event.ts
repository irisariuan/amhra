import type { QueueItem } from "../custom";
import type { LogType } from "../log/load";
import EventEmitter from 'node:events'

export enum SongEditType {
    Pause = 'pause',
    Resume = 'resume',
    Skip = 'skip',
    Stop = 'stop',
    AddSong = 'addSong',
    SetTime = 'setTime',
    RemoveSong = 'removeSong',
    SetVolume = 'setVolume',
    SetQueue = 'setQueue',
    Quit = 'quit',
    Mute = 'mute',
    Unmute = 'unmute',
    Loop = 'loop',
}

export type ExpressEventDetail = {
    url?: string
    sec?: number
    index?: number
    volume?: number
    queue?: QueueItem[]
    time?: number,
    loop?: boolean,
}

export enum ActionType {
    Exit = 'exit',
    AddAuth = 'addAuth',
    ReloadCommands = 'reload',
    ReloadSetting = 'reloadSetting'
}

export class ExpressEvent extends EventEmitter {
    on(event: 'action', listener: (action: ActionType) => void | Promise<void>): this
    on(event: 'log', listener: (message: string, type: LogType) => void | Promise<void>): this
    on(event: 'reloadCommands', listener: () => void | Promise<void>): this
    on(event: 'page', listener: (path: string) => void | Promise<void>): this
    on(event: 'songInterruption', listener: ((guildId: string, action: SongEditType, detail: ExpressEventDetail) => void | Promise<void>) | ((guildId: string, action: SongEditType) => void | Promise<void>)): this
    // biome-ignore lint/suspicious/noExplicitAny: Function overloaded
    on(event: string, listener: (...args: any[]) => void | Promise<void>) {
        return super.on(event, listener)
    }
    emitSong<T extends SongEditType>(guildId: string, action: T, detail: ExpressEventDetail) {
        return super.emit('songInterruption', guildId, action, detail)
    }
    emitPage(path: string) {
        return super.emit('page', path)
    }
    emitAction(action: ActionType) {
        return super.emit('action', action)
    }
    emitSongInfo(url: string) {
        return super.emit('songInfo', url)
    }
    emitReloadCommands() {
        return super.emit('reloadCommands')
    }
}

export const event = new ExpressEvent()