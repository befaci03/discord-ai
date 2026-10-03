/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// TooLang time module

import { RuntimeError } from "../evaluator.js";

export function time(): Record<string, unknown> {
	return {
		now: () => Date.now(),
		timestamp: () => Math.floor(Date.now() / 1000),
		iso: () => new Date().toISOString(),
		date: () => new Date().toDateString(),
		timeString: () => new Date().toTimeString(),
		uptime: () => Math.floor(process.uptime()),
		fromIso: (s: unknown) => {
			const d = new Date(String(s));
			if (Number.isNaN(d.getTime())) throw new RuntimeError(`time.fromIso: invalid ISO date '${String(s).slice(0, 50)}'`);
			return d.getTime();
		},
		toIso: (ms: unknown) => new Date(Number(ms)).toISOString(),
		year: (ms?: unknown) => new Date(ms === undefined ? Date.now() : Number(ms)).getUTCFullYear(),
		month: (ms?: unknown) => new Date(ms === undefined ? Date.now() : Number(ms)).getUTCMonth() + 1,
		day: (ms?: unknown) => new Date(ms === undefined ? Date.now() : Number(ms)).getUTCDate(),
		hour: (ms?: unknown) => new Date(ms === undefined ? Date.now() : Number(ms)).getUTCHours(),
		minute: (ms?: unknown) => new Date(ms === undefined ? Date.now() : Number(ms)).getUTCMinutes(),
		second: (ms?: unknown) => new Date(ms === undefined ? Date.now() : Number(ms)).getUTCSeconds(),
		weekday: (ms?: unknown) => new Date(ms === undefined ? Date.now() : Number(ms)).getUTCDay(),
		/** seconds -> "1h 02m 03s" */
		humanize: (seconds: unknown) => {
			const total = Math.max(0, Math.floor(Number(seconds)));
			const h = Math.floor(total / 3600);
			const m = Math.floor((total % 3600) / 60);
			const s = total % 60;
			const parts: string[] = [];
			if (h > 0) parts.push(`${h}h`);
			if (m > 0 || h > 0) parts.push(`${String(m).padStart(2, "0")}m`);
			parts.push(`${String(s).padStart(2, "0")}s`);
			return parts.join(" ");
		},
	};
}
