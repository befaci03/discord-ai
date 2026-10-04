// Regression tests for the status endpoint: it used to report
// `bot.online: false` forever (deps.client was never set) and the agent card
// carried no state at all.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadConfig, resetConfigCache } from '../utils/config.js';
import { ToolRegistry } from '../modules/tools.js';
import { SkillRegistry } from '../modules/skills.js';
import { AddonRegistry } from '../modules/addons.js';
import { AddonStatus } from '../modules/types.js';
import SQLiteDB from '../db/sqlite.js';
import { DashboardDeps, handleApi } from '../dashboard/handlers.js';

let dir: string;
let db: SQLiteDB;
let deps: DashboardDeps;

beforeAll(async () => {
	resetConfigCache();
	dir = mkdtempSync(path.join(tmpdir(), 'discord-ai-dash-'));
	db = new SQLiteDB(path.join(dir, 'dash.sqlite'));
	await db.init();
	const config = loadConfig('example.config.toml');
	const tools = new ToolRegistry(config);
	tools.loadAll();
	const skills = new SkillRegistry(config);
	skills.loadAll();
	const addons = new AddonRegistry(config);
	await addons.loadAll();
	deps = { config, db, tools, skills, addons, log: () => undefined };
});

afterAll(async () => {
	await db.close();
	rmSync(dir, { recursive: true, force: true });
});

async function status(): Promise<Record<string, never>> {
	const res = await handleApi({ headers: {} } as never, deps, '/api/status', 'GET');
	expect(res.status).toBe(200);
	return res.body as Record<string, never>;
}

describe('/api/status', () => {
	test('reports offline while no discord client is wired', async () => {
		const body = (await status()) as unknown as { bot: { online: boolean; guilds: number } };
		expect(body.bot.online).toBe(false);
		expect(body.bot.guilds).toBe(0);
	});

	test('reports the real bot once the client is attached', async () => {
		deps.client = { user: { tag: 'Bot#0001' }, guilds: { cache: { size: 3 } } };
		const body = (await status()) as unknown as { bot: { online: boolean; user: string | null; guilds: number } };
		expect(body.bot.online).toBe(true);
		expect(body.bot.user).toBe('Bot#0001');
		expect(body.bot.guilds).toBe(3);
	});

	test('exposes live agent state when a hook is wired', async () => {
		const idle = (await status()) as unknown as { agent: { busy?: boolean; llm: string } };
		expect(idle.agent.busy).toBeUndefined();

		deps.agentState = () => ({ busy: true, doing: 'thinking', mode: 'coding' });
		const busy = (await status()) as unknown as { agent: { busy: boolean; doing: string; mode: string } };
		expect(busy.agent.busy).toBe(true);
		expect(busy.agent.doing).toBe('thinking');
		expect(busy.agent.mode).toBe('coding');
	});

	test('llm reflects key availability instead of always saying configured', async () => {
		const withKey = (apiKey: string): DashboardDeps => ({
			...deps,
			config: {
				...deps.config,
				agent: {
					...deps.config.agent,
					providers: { openai: { api_type: 1, base_url: 'https://api.openai.com/v1', api_key: apiKey } },
					models: { ...deps.config.agent.models, default_model: { provider: 'openai', model: 'gpt-test' } }
				}
			}
		});
		const llm = async (deps2: DashboardDeps): Promise<string> => {
			const res = await handleApi({ headers: {} } as never, deps2, '/api/status', 'GET');
			return (res.body as { agent: { llm: string } }).agent.llm;
		};
		// an unexpanded ${VAR} reference is not a key
		expect(await llm(withKey('${OPENAI_API_KEY}'))).toBe('off');
		expect(await llm(withKey('sk-test'))).toBe('configured');
	});
});

// The four toggle kinds share ONE handler. These cover the regressions the
// split `function` path shipped with: a truthy non-boolean used to count as
// "disable", and enabling a function of a disabled addon returned ok + wrote a
// `function.enable` audit row for a state that never happened.
describe('runtime toggles', () => {
	/** POST a JSON body: readApiBody consumes the request as a stream. */
	const post = (pathName: string, body: unknown, d: DashboardDeps = deps) => handleApi(Readable.from([Buffer.from(JSON.stringify(body))]) as never, d, pathName, 'POST');
	const get = (pathName: string, d: DashboardDeps = deps) => handleApi({ headers: {} } as never, d, pathName, 'GET');

	/** Fresh registries, so one test's flips can never leak into the next. */
	async function fresh(overrides: Partial<DashboardDeps> = {}): Promise<DashboardDeps> {
		const addons = new AddonRegistry(deps.config);
		await addons.loadAll();
		return { ...deps, addons, ...overrides };
	}

	const functionState = async (d: DashboardDeps, name: string): Promise<boolean | undefined> => {
		const body = (await get('/api/addons', d)).body as AddonStatus[];
		return body[0]?.functionStates?.find((f) => f.name === name)?.enabled;
	};

	test('a function toggle flips exactly one addon function', async () => {
		const d = await fresh();
		expect(await functionState(d, 'weather_now')).toBe(true);

		const off = await post('/api/functions/toggle', { name: 'weather_now', enabled: false }, d);
		expect(off.status).toBe(200);
		expect((off.body as { enabled: boolean }).enabled).toBe(false);
		expect(await functionState(d, 'weather_now')).toBe(false);
		expect(await functionState(d, 'weather_forecast')).toBe(true); // sibling untouched

		const on = await post('/api/functions/toggle', { name: 'weather_now', enabled: true }, d);
		expect(on.status).toBe(200);
		expect(await functionState(d, 'weather_now')).toBe(true);
	});

	test('enabled must be a real boolean, never guessed from truthiness', async () => {
		const d = await fresh();
		// regression: `enabled === true` turned the string "true" (and 1) into a
		// DISABLE of whatever the name pointed at
		const res = await post('/api/functions/toggle', { name: 'weather_now', enabled: 'true' }, d);
		expect(res.status).toBe(400);
		expect((res.body as { error: string }).error).toContain('enabled must be');
		expect(await functionState(d, 'weather_now')).toBe(true); // untouched

		const tools = new ToolRegistry(deps.config);
		tools.loadAll();
		const tool = tools.all()[0]?.name;
		expect(tool).toBeTruthy();
		expect((await post('/api/tools/toggle', { name: tool!, enabled: 1 }, d)).status).toBe(400);
		expect(tools.isEnabled(tool!)).toBe(true);
	});

	test('a function of a disabled addon is refused, not silently pretended', async () => {
		const d = await fresh();
		expect((await post('/api/addons/toggle', { name: 'weather', enabled: false }, d)).status).toBe(200);
		const enablesBefore = (await d.db.recentAudit(50)).filter((r) => r.action === 'function.enable' && r.target === 'weather_now').length;

		const res = await post('/api/functions/toggle', { name: 'weather_now', enabled: true }, d);
		expect(res.status).toBe(409);
		expect((res.body as { error: string }).error).toContain("addon 'weather' is disabled");
		// no audit row for an enable that did not happen
		const enablesAfter = (await d.db.recentAudit(50)).filter((r) => r.action === 'function.enable' && r.target === 'weather_now').length;
		expect(enablesAfter).toBe(enablesBefore);
		expect(await functionState(d, 'weather_now')).toBe(false);

		// switching it OFF is still allowed: that state really is in effect
		expect((await post('/api/functions/toggle', { name: 'weather_now', enabled: false }, d)).status).toBe(200);
	});

	test('unknown and internal functions get different answers', async () => {
		const d = await fresh();
		expect((await post('/api/functions/toggle', { name: 'nope_nope', enabled: true }, d)).status).toBe(404);

		// internal = "wired into the addon": 400 with its own wording, no registry write
		const internal = {
			...d,
			addons: { hasFunction: () => true, isInternalFunction: () => true } as unknown as AddonRegistry
		};
		const res = await post('/api/functions/toggle', { name: 'weather_now', enabled: false }, internal);
		expect(res.status).toBe(400);
		expect((res.body as { error: string }).error).toContain('internal');
	});

	test('tools and addons keep working through the same handler', async () => {
		const tools = new ToolRegistry(deps.config);
		tools.loadAll();
		const d = await fresh({ tools });
		const tool = tools.all()[0]?.name!;
		expect((await post('/api/tools/toggle', { name: tool, enabled: false }, d)).status).toBe(200);
		expect(tools.isEnabled(tool)).toBe(false);
		expect((await post('/api/tools/toggle', { name: tool, enabled: true }, d)).status).toBe(200);
		expect(tools.isEnabled(tool)).toBe(true);
		// unknown names still 404 on every kind
		expect((await post('/api/addons/toggle', { name: 'nope', enabled: false }, d)).status).toBe(404);
	});
});
