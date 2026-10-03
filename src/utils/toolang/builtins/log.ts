/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// TooLang log module: structured-ish logging from tool scripts
// Secrets should never go through here, but we still cap sizes.

import { RuntimeError } from "../evaluator.js";

function fmt(value: unknown): string {
	if (typeof value === "string") return value;
	try { return JSON.stringify(value) ?? String(value) }
	catch { return String(value) }
}

function cap(text: string, max = 2000): string {
	return text.length > max ? text.slice(0, max) + `... (${text.length} chars total)` : text;
}

export function log(): Record<string, Function> {
	return {
		info: (...args: unknown[]) => { console.log("[tool:info]", cap(args.map(fmt).join(" "))); return null },
		warn: (...args: unknown[]) => { console.warn("[tool:warn]", cap(args.map(fmt).join(" "))); return null },
		error: (...args: unknown[]) => { console.error("[tool:error]", cap(args.map(fmt).join(" "))); return null },
		debug: (...args: unknown[]) => {
			if (process.env.DEBUG === "1" || process.env.DEBUG === "true") console.debug("[tool:debug]", cap(args.map(fmt).join(" ")));
			return null;
		},
	};
}
