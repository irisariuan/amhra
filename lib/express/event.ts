import type { LogType } from "../log/load";
import type { SongEditType } from "./type";

const EventEmitter = require('node:events')

interface Song {
    url: string
}

type ExpressEventDetail<T extends SongEditType> = ExpressEventDetailMap[T]
type ExpressEventDetailMap = {
    [SongEditType.Pause]: {}
    [SongEditType.Resume]: {}
    [SongEditType.Skip]: {}
    [SongEditType.Stop]: {}
    [SongEditType.AddSong]: { song: Song }
    [SongEditType.SetTime]: { sec: number }
    [SongEditType.RemoveSong]: { index: number }
    [SongEditType.SetVolume]: { volume: number }
    [SongEditType.SetQueue]: { queue: Song[] }
    [SongEditType.Quit]: {}
    [SongEditType.Seek]: { time: number }
}

// export declare interface ExpressEvent {
//     on(event: 'songInterruption', listener: (guildId: string, action: SongEditType.Pause) => void | Promise<void>): this;
//     on(event: 'songInterruption', listener: <T extends SongEditType>(guildId: string, action: T, detail?: ExpressEventDetail<T>) => void | Promise<void>): this;
//     emit<T extends SongEditType>(event: 'songInterruption', guildId: string, action: T, detail?: ExpressEventDetail<T>)
// }

export class ExpressEvent extends EventEmitter {
    on(event: 'globalAction', listener: (action: 'exit' | 'addAuth') => void | Promise<void>): this
    on(event: 'log', listener: (message: string, type: LogType) => void | Promise<void>): this
    on(event: 'action', listener: (action: string) => void | Promise<void>): this
    on(event: 'page', listener: (path: string) => void | Promise<void>): this
    on(event: 'songInterruption', listener: (<T extends SongEditType>(guildId: string, action: T, detail: ExpressEventDetail<T>) => void | Promise<void>) | ((guildId: string, action: SongEditType) => void | Promise<void>)): this
    on(event: string, listener: (...any) => void | Promise<void>) {
        return super.on(event, listener)
    }
    emit() {

    }
    emitSong<T extends SongEditType>(event: 'songInterruption', guildId: string, action: T, detail: ExpressEventDetail<T>) {
        return super.emit(event, guildId, action, detail)
    }
    emitPage(path: string) {
        return super.emit('page', path)
    }
    emitAction(action: 'exit' | 'addAuth') {
        return super.emit('globalAction', action)
    }
}

export const event = new ExpressEvent()