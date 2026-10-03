// The cron addon: schedules are parsed by hand (no eval), jobs are pinned to
// channels and gated by allow_job_creation, and a fired job runs the prompt
// through the agent then posts the answer with pings disabled.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadConfig, resetConfigCache, AppConfig } from '../utils/config.js';
import SQLiteDB from '../db/sqlite.js';
import type Agent from '../agent/struct.js';
import { Cron, getConfig, parseCron, cronMatches, parseInterval, normalizeSchedule, nextCronAfter, setRuntime, resetForTests } from '../../modules/addons/cron.js';

let dir: string;
let db: SQLiteDB;
let askError: Error | null = null;
const sent: { content: string; allowedMentions: { parse: string[] } }[] = [];

function makeConfig(cron: Record<string, unknown>): AppConfig {
	const base = loadConfig('example.config.toml');
	return { ...base, addons: { enabled: ['cron'], cron } } as AppConfig;
}

function fnNamed(name: string) {
	const found = Cron.functions.find((f) => f.name === name);
	if (!found) throw new Error(`function ${name} not registered`);
	return found;
}

async function failureOf(call: () => Promise<unknown>): Promise<string> {
	try {
		await call();
	} catch (err) {
		return (err as Error).message;
	}
	return '';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
	dir = mkdtempSync(path.join(tmpdir(), 'discord-ai-cron-'));
	db = new SQLiteDB(path.join(dir, 'cron.sqlite'));
	await db.init();

	const agent = {
		ask: async (prompt: string) => {
			if (askError) throw askError;
			return { choices: [{ message: { content: `answer to: ${prompt.slice(0, 40)}` } }] };
		}
	} as unknown as Agent;
	const client = {
		isReady: () => true,
		channels: {
			fetch: async () => ({
				isTextBased: () => true,
				send: async (payload: { content: string; allowedMentions: { parse: string[] } }) => {
					sent.push(payload);
				}
			})
		}
	};
	setRuntime({ db, agent, client, log: () => undefined });
	await sleep(20); // setRuntime loads saved jobs in the background
});

afterAll(async () => {
	await db.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
	resetConfigCache();
	askError = null;
	sent.length = 0;
	await resetForTests();
});

describe('schedule parsing', () => {
	test('5-field expressions become sets of allowed values', () => {
		const f = parseCron('*/15 * * * *');
		expect([...f.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
		expect(f.hour.has(13)).toBe(true);
		expect(parseCron('0 9-17 * * 1-5').hour.has(12)).toBe(true);
		expect(parseCron('0 9-17 * * 1-5').hour.has(18)).toBe(false);
		expect(parseCron('0 9-17 * * 1-5').dow.has(6)).toBe(false);
		expect(parseCron('@daily').raw).toBe('0 0 * * *');
		expect(parseCron('0,30 12 * * *').minute.has(30)).toBe(true);
	});

	test('junk schedules are refused with a fixable message', () => {
		expect(() => parseCron('whenever')).toThrow('5 fields');
		expect(() => parseCron('99 * * * *')).toThrow('out of range');
		expect(() => parseCron('* * * * 9')).toThrow('out of range');
		expect(() => parseCron('*/0 * * * *')).toThrow('bad step');
	});

	test('intervals cover minutes, hours and days with sane bounds', () => {
		expect(parseInterval('every 30m')).toBe(30 * 60_000);
		expect(parseInterval('every 2 hours')).toBe(2 * 3_600_000);
		expect(parseInterval('every 1d')).toBe(86_400_000);
		expect(() => parseInterval('every 5s')).toThrow('5-field');
		expect(() => parseInterval('every 0m')).toThrow('1 minute');
		expect(() => parseInterval('every 999d')).toThrow('30 days');
	});

	test('normalizeSchedule picks the right kind', () => {
		expect(normalizeSchedule('*/5 * * * *')).toEqual({ kind: 'cron', expr: '*/5 * * * *' });
		expect(normalizeSchedule('every 15m')).toEqual({ kind: 'interval', interval_ms: 15 * 60_000 });
		expect(() => normalizeSchedule('   ')).toThrow('empty');
	});

	test('nextCronAfter finds the real next fire time (not "now")', () => {
		const f = parseCron('0 9 * * *');
		// 2026-10-03 08:00 -> later today at 09:00
		expect(nextCronAfter(f, new Date(2026, 9, 3, 8, 0))?.getTime()).toBe(new Date(2026, 9, 3, 9, 0).getTime());
		// exactly on the slot -> tomorrow (a job never fires twice per minute)
		expect(nextCronAfter(f, new Date(2026, 9, 3, 9, 0))?.getTime()).toBe(new Date(2026, 9, 4, 9, 0).getTime());
		// a date that never comes has no next run instead of hanging the add call
		expect(nextCronAfter(parseCron('0 0 30 2 *'), new Date(2026, 9, 3))).toBeUndefined();
	});
});

describe('matching', () => {
	test('fires on the minutes the expression allows, nothing else', () => {
		const f = parseCron('*/15 * * * *');
		expect(cronMatches(f, new Date(2026, 9, 3, 10, 0))).toBe(true);
		expect(cronMatches(f, new Date(2026, 9, 3, 10, 45))).toBe(true);
		expect(cronMatches(f, new Date(2026, 9, 3, 10, 7))).toBe(false);
	});

	test("day-of-month and day-of-week combine with cron's OR rule", () => {
		// 2026-10-02 is a Friday, 2026-10-13 a Tuesday
		const f = parseCron('0 0 13 * 5');
		expect(f.orDays).toBe(true);
		expect(cronMatches(f, new Date(2026, 9, 13, 0, 0))).toBe(true); // the 13th
		expect(cronMatches(f, new Date(2026, 9, 2, 0, 0))).toBe(true); // a Friday
		expect(cronMatches(f, new Date(2026, 9, 3, 0, 0))).toBe(false); // neither
	});

	test('a plain wildcard day expression still needs both to match', () => {
		const f = parseCron('30 8 * * *');
		expect(f.orDays).toBe(false);
		expect(cronMatches(f, new Date(2026, 9, 3, 8, 30))).toBe(true);
		expect(cronMatches(f, new Date(2026, 9, 3, 8, 31))).toBe(false);
	});
});

describe('config', () => {
	test('defaults are conservative: no creation, 10 jobs, no channel restriction', () => {
		const cfg = getConfig(makeConfig({}));
		expect(cfg.allow_job_creation).toBe(false);
		expect(cfg.max_jobs).toBe(10);
		expect(cfg.allowed_channels).toEqual([]);
	});

	test('max_jobs is clamped and channel ids are validated', () => {
		expect(getConfig(makeConfig({ max_jobs: 999 })).max_jobs).toBe(50);
		expect(getConfig(makeConfig({ max_jobs: 0 })).max_jobs).toBe(1);
		expect(() => getConfig(makeConfig({ allowed_channels: ['not-an-id'] }))).toThrow('channel id');
		expect(getConfig(makeConfig({ allowed_channels: ['1234567890'] })).allowed_channels).toEqual(['1234567890']);
	});
});

describe('function list', () => {
	beforeEach(() => resetConfigCache());

	test('allow_job_creation off: read-only', async () => {
		await Cron.init!(makeConfig({}));
		expect(Cron.functions.map((f) => f.name)).toEqual(['cron_list']);
	});

	test('allow_job_creation on: add, remove and run-now appear, all mutating', async () => {
		await Cron.init!(makeConfig({ allow_job_creation: true }));
		expect(Cron.functions.map((f) => f.name)).toEqual(['cron_list', 'cron_add', 'cron_remove', 'cron_run_now']);
		for (const name of ['cron_add', 'cron_remove', 'cron_run_now']) {
			expect(Cron.functions.find((f) => f.name === name)?.dangerous, name).toBe(true);
		}
	});
});

describe('job lifecycle', () => {
	beforeEach(async () => {
		resetConfigCache();
		await Cron.init!(makeConfig({ allow_job_creation: true, max_jobs: 5, allowed_channels: ['111111111111111111'] }));
	});

	test('add -> list -> persisted in the kv store', async () => {
		const added = (await fnNamed('cron_add').execute({
			schedule: 'every 1h',
			prompt: 'post a status update',
			channel_id: '111111111111111111'
		})) as Record<string, unknown>;
		expect(String(added.id)).toMatch(/^j[0-9a-f]{8}$/);

		const list = (await fnNamed('cron_list').execute({})) as { id: string; schedule: string }[];
		expect(list).toHaveLength(1);
		expect(list[0].schedule).toBe('every 60m');

		const saved = await db.kvGet('cron', 'jobs');
		expect(saved).toContain(String(added.id));
		expect(saved).toContain('post a status update');
	});

	test('channels outside allowed_channels are refused', async () => {
		expect(await failureOf(() => fnNamed('cron_add').execute({ schedule: 'every 1h', prompt: 'hi', channel_id: '999999999999999999' }))).toContain('allowed_channels');
	});

	test('schedules, prompts and job counts are all capped', async () => {
		expect(await failureOf(() => fnNamed('cron_add').execute({ schedule: 'whenever', prompt: 'hi', channel_id: '111111111111111111' }))).toContain('5 fields');
		expect(await failureOf(() => fnNamed('cron_add').execute({ schedule: 'every 1h', prompt: 'x'.repeat(2001), channel_id: '111111111111111111' }))).toContain('2000');
		expect(await failureOf(() => fnNamed('cron_add').execute({ schedule: 'every 1h', prompt: 'hi', channel_id: 'nope' }))).toContain('channel id');

		for (let i = 0; i < 5; i++) {
			await fnNamed('cron_add').execute({ schedule: 'every 1h', prompt: `job ${i}`, channel_id: '111111111111111111' });
		}
		expect(await failureOf(() => fnNamed('cron_add').execute({ schedule: 'every 1h', prompt: 'one too many', channel_id: '111111111111111111' }))).toContain('job limit');
	});

	test('run_now posts the answer with pings disabled', async () => {
		const added = (await fnNamed('cron_add').execute({
			schedule: '0 9 * * *',
			prompt: 'daily standup',
			channel_id: '111111111111111111'
		})) as { id: string };

		const result = (await fnNamed('cron_run_now').execute({ job_id: added.id })) as { runs: number; last_error: string | null };
		expect(result.runs).toBe(1);
		expect(result.last_error).toBeNull();
		expect(sent).toHaveLength(1);
		expect(sent[0].content).toContain('answer to: daily standup');
		expect(sent[0].allowedMentions.parse).toEqual([]);
	});

	test('a failing agent run lands in last_error, not in the channel', async () => {
		const added = (await fnNamed('cron_add').execute({
			schedule: '0 9 * * *',
			prompt: 'daily standup',
			channel_id: '111111111111111111'
		})) as { id: string };
		askError = new Error('provider exploded');

		const result = (await fnNamed('cron_run_now').execute({ job_id: added.id })) as { last_error: string };
		expect(result.last_error).toContain('provider exploded');
		expect(sent).toHaveLength(0);
	});

	test('remove drops the job and the saved copy', async () => {
		const added = (await fnNamed('cron_add').execute({
			schedule: 'every 1d',
			prompt: 'x',
			channel_id: '111111111111111111'
		})) as { id: string };
		await fnNamed('cron_remove').execute({ job_id: added.id });

		const list = (await fnNamed('cron_list').execute({})) as unknown[];
		expect(list).toEqual([]);
		expect(await db.kvGet('cron', 'jobs')).not.toContain(added.id);
		expect(await failureOf(() => fnNamed('cron_remove').execute({ job_id: 'j00000000' }))).toContain('unknown job');
	});

	test('saved jobs are re-checked against the CURRENT config when they load', async () => {
		const good = { id: 'jaaaaaaaa', kind: 'interval', interval_ms: 3_600_000, prompt: 'ok', channel_id: '111111111111111111', created_at: Date.now(), runs: 0 };
		// channel no longer allowed, junk schedule, junk id, junk kind
		const offChannel = { ...good, id: 'jbbbbbbbb', channel_id: '999999999999999999' };
		const badExpr = { ...good, id: 'jcccccccc', kind: 'cron', expr: 'whenever' };
		const badId = { ...good, id: '../../etc' };
		const badKind = { ...good, id: 'jdddddddd', kind: 'someday' };
		await db.kvSet('cron', 'jobs', JSON.stringify([good, offChannel, badExpr, badId, badKind]));

		setRuntime({ db }); // triggers the load
		await sleep(30);

		const list = (await fnNamed('cron_list').execute({})) as { id: string }[];
		// shrinking allowed_channels must take effect on restart, not only on add
		expect(list.map((j) => j.id)).toEqual(['jaaaaaaaa']);
	});
});
