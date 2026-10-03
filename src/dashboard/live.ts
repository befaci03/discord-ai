// Live event bus: collects interesting things happening in the app and
// pushes them to connected dashboard clients over the WebSocket hub.
// Emission is cheap and never throws (logging must not break the app).

import { WsHub } from "./ws.js";
import { Logger } from "../utils/logger.js";

export type LiveEvent =
	| { kind: "tool.run"; tool: string; caller: string; ok: boolean; ms: number; error?: string }
	| { kind: "audit"; action: string; actor: string; target: string }
	| { kind: "bot.status"; online: boolean; user?: string; guilds?: number }
	| { kind: "agent.status"; busy: boolean; doing: string; mode: string }
	| { kind: "log"; level: "info" | "warn" | "error"; message: string };

export class LiveBus {
	private hub: WsHub | null = null;
	private log: Logger;

	constructor(log: Logger) {
		this.log = log.child("live");
	}

	attachHub(hub: WsHub): void {
		this.hub = hub;
	}

	get clients(): number {
		return this.hub?.clientCount() ?? 0;
	}

	emit(event: LiveEvent): void {
		if (!this.hub || this.hub.clientCount() === 0) return;
		try {
			this.hub.broadcast("event", { ...event, at: Date.now() });
		} catch (err) {
			this.log.warn(`broadcast failed: ${err instanceof Error ? err.message : err}`);
		}
	}
}
