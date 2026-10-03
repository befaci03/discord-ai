// Tiny leveled logger. No external deps, redacts obvious secrets.
// Optional file sink via logging.file in config.

import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_PATTERNS: RegExp[] = [
	/(bot|token|authorization)["']?\s*[:=]\s*\S+/gi,
	/sk-[a-zA-Z0-9-]{8,}/g,
	/ghp_[a-zA-Z0-9]{20,}/g,
];

function redact(text: string): string {
	return SECRET_PATTERNS.reduce((acc, rx) => acc.replace(rx, "[REDACTED]"), text);
}

function fmt(value: unknown): string {
	if (typeof value === "string") return value;
	try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
}

export class Logger {
	private static sinks: { file: string }[] = [];

	/** Attach a log file (called once at startup). Creates parent dirs. */
	static addFileSink(file: string): void {
		const abs = path.resolve(file);
		mkdirSync(path.dirname(abs), { recursive: true });
		Logger.sinks.push({ file: abs });
	}

	constructor(private level: Level = "info", private scope = "app") {}

	child(scope: string): Logger {
		return new Logger(this.level, `${this.scope}:${scope}`);
	}

	private write(level: Level, args: unknown[]): void {
		const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${this.scope}] ${redact(args.map(fmt).join(" "))}`;
		if (LEVEL_ORDER[level] >= LEVEL_ORDER[this.level]) {
			const target = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
			target(line);
		}
		for (const sink of Logger.sinks) {
			try {
				appendFileSync(sink.file, line + "\n");
			} catch {
				// never let logging break the app; drop the broken sink
				Logger.sinks = Logger.sinks.filter((s) => s !== sink);
			}
		}
	}

	debug(...args: unknown[]): void { this.write("debug", args) }
	info(...args: unknown[]): void { this.write("info", args) }
	warn(...args: unknown[]): void { this.write("warn", args) }
	error(...args: unknown[]): void { this.write("error", args) }
}
