/// Addon: cron (schedules half)
/// Config parsing plus the hand-rolled schedule engine: 5-field cron
/// expressions and "every 30m" style intervals. Everything is validated field
/// by field and evaluated with plain set lookups: no eval, no shell, no deps.
///
/// Matching runs on server local time (like real cron), including the classic
/// rule that day-of-month and day-of-week combine with OR when both are
/// restricted (e.g. "0 0 13 * 5" fires on the 13th OR on any Friday).

import { AppConfig } from '../../src/utils/config.js';

const CHANNEL_RE = /^\d{5,25}$/;

export interface CronConfig {
	allow_job_creation: boolean;
	max_jobs: number;
	/** channel ids the agent may schedule into; empty = any channel */
	allowed_channels: string[];
}

export interface CronJob {
	id: string;
	/** "cron" = 5-field expr, "interval" = every N <unit> */
	kind: 'cron' | 'interval';
	expr?: string;
	/** interval length in ms (kind = interval) */
	interval_ms?: number;
	prompt: string;
	channel_id: string;
	created_at: number;
	runs: number;
	/** minute key (epoch ms / 60000) of the last cron fire, skips repeats */
	last_key?: number;
	/** epoch ms of the next interval fire */
	next_at?: number;
	running?: boolean;
	last_run_at?: number;
	last_error?: string;
}

const ALIASES: Record<string, string> = {
	'@hourly': '0 * * * *',
	'@daily': '0 0 * * *',
	'@midnight': '0 0 * * *',
	'@weekly': '0 0 * * 0',
	'@monthly': '0 0 1 * *',
	'@yearly': '0 0 1 1 *',
	'@annually': '0 0 1 1 *'
};

function bool(raw: Record<string, unknown>, key: string): boolean {
	return raw[key] === true;
}

export function getConfig(config: AppConfig): CronConfig {
	const raw = (config.addons as unknown as Record<string, Record<string, unknown>>).cron ?? {};
	const max = Number(raw.max_jobs ?? 10);
	const channels = Array.isArray(raw.allowed_channels)
		? raw.allowed_channels
				.map(String)
				.map((c) => c.trim())
				.filter(Boolean)
		: [];
	for (const c of channels) if (!CHANNEL_RE.test(c)) throw new Error(`cron: allowed_channels entry '${c.slice(0, 24)}' is not a channel id`);
	return {
		allow_job_creation: bool(raw, 'allow_job_creation'),
		max_jobs: Math.min(Math.max(Number.isFinite(max) ? Math.floor(max) : 10, 1), 50),
		allowed_channels: channels.slice(0, 50)
	};
}

// ---------------- schedule parsing ----------------

function parseField(field: string, min: number, max: number, label: string): Set<number> {
	const out = new Set<number>();
	for (const part of field.split(',')) {
		if (part.length === 0) throw new Error(`cron: empty ${label} entry`);
		const [rangePart, stepPart, ...rest] = part.split('/');
		if (rest.length > 0) throw new Error(`cron: bad ${label} entry '${part}'`);
		const step = stepPart === undefined ? 1 : Number(stepPart);
		if (!Number.isInteger(step) || step < 1 || step > max) throw new Error(`cron: bad step in ${label} entry '${part}'`);
		let lo = min;
		let hi = max;
		if (rangePart !== '*') {
			const m = /^(\d+)(?:-(\d+))?$/.exec(rangePart);
			if (!m) throw new Error(`cron: bad ${label} field '${field}'`);
			lo = Number(m[1]);
			hi = m[2] === undefined ? lo : Number(m[2]);
			if (lo < min || hi > max || lo > hi) throw new Error(`cron: ${label} value out of range in '${part}' (${min}-${max})`);
		}
		for (let v = lo; v <= hi; v += step) out.add(v);
	}
	if (out.size === 0) throw new Error(`cron: ${label} field matches nothing`);
	return out;
}

export interface CronFields {
	minute: Set<number>;
	hour: Set<number>;
	dom: Set<number>;
	month: Set<number>;
	dow: Set<number>;
	/** true when both dom and dow are restricted (real cron uses OR then) */
	orDays: boolean;
	raw: string;
}

/** Parse a 5-field cron expression (or an @alias). No eval, ever. */
export function parseCron(exprRaw: unknown): CronFields {
	const expr = String(exprRaw ?? '')
		.trim()
		.toLowerCase();
	const normalized = ALIASES[expr] ?? expr;
	const parts = normalized.split(/\s+/);
	if (parts.length !== 5) throw new Error(`cron: schedule must be 5 fields (min hour dom mon dow) or an alias like @daily, got ${parts.length}`);
	const [minF, hourF, domF, monF, dowF] = parts as [string, string, string, string, string];
	return {
		minute: parseField(minF, 0, 59, 'minute'),
		hour: parseField(hourF, 0, 23, 'hour'),
		dom: parseField(domF, 1, 31, 'day-of-month'),
		month: parseField(monF, 1, 12, 'month'),
		dow: parseField(dowF, 0, 7, 'day-of-week'),
		orDays: domF !== '*' && dowF !== '*',
		raw: normalized
	};
}

/** Does this date fire the expression? (server local time, like real cron) */
export function cronMatches(f: CronFields, date: Date): boolean {
	if (!f.minute.has(date.getMinutes())) return false;
	if (!f.hour.has(date.getHours())) return false;
	if (!f.month.has(date.getMonth() + 1)) return false;
	const domOk = f.dom.has(date.getDate());
	// cron: 0 and 7 are both Sunday
	const dowOk = f.dow.has(date.getDay()) || (date.getDay() === 0 && f.dow.has(7));
	return f.orDays ? domOk || dowOk : domOk && dowOk;
}

/**
 * First moment AFTER `from` that the expression fires (local time, same rules
 * as cronMatches). Bounded to ~1 year, so an impossible date ("0 0 30 2 *")
 * simply has no next run instead of hanging the add call.
 */
export function nextCronAfter(f: CronFields, from: Date): Date | undefined {
	const hours = [...f.hour].sort((a, b) => a - b);
	const minutes = [...f.minute].sort((a, b) => a - b);
	for (let dayOff = 0; dayOff < 370; dayOff++) {
		const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + dayOff);
		if (!f.month.has(day.getMonth() + 1)) continue;
		const domOk = f.dom.has(day.getDate());
		const dowOk = f.dow.has(day.getDay()) || (day.getDay() === 0 && f.dow.has(7));
		if (f.orDays ? !(domOk || dowOk) : !(domOk && dowOk)) continue;
		for (const h of hours) {
			for (const m of minutes) {
				const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
				if (candidate.getTime() > from.getTime()) return candidate;
			}
		}
	}
	return undefined;
}

const INTERVAL_RE = /^every\s+(\d{1,4})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse "every 30m" / "every 2h" / "every 1d" into milliseconds. */
export function parseInterval(raw: unknown): number {
	const s = String(raw ?? '').trim();
	const m = INTERVAL_RE.exec(s);
	if (!m) throw new Error("cron: use a 5-field schedule (e.g. '*/15 * * * *'), an alias (@daily) or 'every 30m'");
	const n = Number(m[1]);
	const unit = m[2].toLowerCase()[0];
	const ms = n * UNIT_MS[unit];
	if (ms < 60_000) throw new Error('cron: the smallest interval is 1 minute');
	if (ms > 30 * 86_400_000) throw new Error('cron: the longest interval is 30 days');
	return ms;
}

/** Normalize whatever the model sent into a job (without an id yet). */
export function normalizeSchedule(scheduleRaw: unknown): Pick<CronJob, 'kind' | 'expr' | 'interval_ms'> {
	const s = String(scheduleRaw ?? '').trim();
	if (s.length === 0) throw new Error('cron: schedule must not be empty');
	if (s.toLowerCase().startsWith('every')) return { kind: 'interval', interval_ms: parseInterval(s) };
	const fields = parseCron(s);
	return { kind: 'cron', expr: fields.raw };
}
