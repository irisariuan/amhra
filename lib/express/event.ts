import type { QueueItem } from "../custom";
import type { LogType } from "../log/load";
import EventEmitter from "node:events";

export enum SongEditType {
	Pause = "pause",
	Resume = "resume",
	Skip = "skip",
	Stop = "stop",
	AddSong = "addSong",
	SetTime = "setTime",
	RemoveSong = "removeSong",
	SetVolume = "setVolume",
	SetQueue = "setQueue",
	Quit = "quit",
	Mute = "mute",
	Unmute = "unmute",
	Loop = "loop",
	SkipSegment = "skipSegment",
}

export type ExpressEventDetail = {
	url?: string;
	sec?: number;
	index?: number;
	volume?: number;
	queue?: QueueItem[];
	time?: number;
	loop?: boolean;
};

export enum ActionType {
	Exit = "exit",
	AddAuth = "addAuth",
	ReloadCommands = "reload",
	ReloadSetting = "reloadSetting",
}

export class ExpressEvent extends EventEmitter {
	on(
		event: "log",
		listener: (message: string, type: LogType) => void | Promise<void>,
	): this;
	on(event: "reloadCommands", listener: () => void | Promise<void>): this;
	on(event: "page", listener: (path: string) => void | Promise<void>): this;
	on(event: string, listener: (...args: any[]) => void | Promise<void>) {
		return super.on(event, listener);
	}
	emitPage(path: string) {
		return super.emit("page", path);
	}
	emitReloadCommands() {
		return super.emit("reloadCommands");
	}
}

export const event = new ExpressEvent();
