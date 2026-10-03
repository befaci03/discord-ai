// Regression tests for the status endpoint: it used to report
// `bot.online: false` forever (deps.client was never set) and the agent card
// carried no state at all.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadConfig, resetConfigCache } from '../utils/config.js';
import { ToolRegistry } from '../modules/tools.js';
import { SkillRegistry } from '../modules/skills.js';
import { AddonRegistry } from '../modules/addons.js';
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
