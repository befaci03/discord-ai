// Model-type tools: each configured type exposes exactly one llm_* tool,
// nothing shows up under use_same_models, and a dedicated coding model keeps
// the DEFAULT model master of the conversation (llm_code does the coding).

import { describe, test, expect, beforeEach } from 'bun:test';
import { loadConfig, resetConfigCache, AppConfig } from '../utils/config.js';
import { buildAgent } from '../agent/factory.js';
import { Tool } from '../agent/struct.js';
import SQLiteDB from '../db/sqlite.js';
import { Logger } from '../utils/logger.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

let db: SQLiteDB;
let dir: string;

beforeEach(async () => {
	resetConfigCache();
	if (!dir) {
		dir = mkdtempSync(path.join(tmpdir(), 'discord-ai-llmtools-'));
		db = new SQLiteDB(path.join(dir, 'llm.sqlite'));
		await db.init();
	}
});

function withKey(c: AppConfig): AppConfig {
	c.agent.providers = { openai: { api_type: 1, base_url: 'https://api.openai.com/v1', api_key: 'sk-test' } };
	return c;
}

function typedCfg(types: { coding?: boolean; image?: boolean; video?: boolean }): AppConfig {
	const c = withKey(loadConfig('example.config.toml'));
	c.agent.models = {
		use_same_models: false,
		default_model: { provider: 'openai', model: 'gpt-test' },
		coding_model: types.coding ? [{ enabled: true, provider: 'openai', model: 'codex-test' }] : [],
		image_model: types.image ? [{ enabled: true, provider: 'openai', model: 'image-test' }] : [],
		video_model: types.video ? [{ enabled: true, provider: 'openai', model: 'video-test' }] : [],
		tts_model: [],
		stt_model: [],
		rerank_model: []
	};
	return c;
}

describe('llm_* model-type tools', () => {
	test('an enabled image model exposes llm_gen_image, an unconfigured video none', async () => {
		const tools: Tool[] = [];
		const agent = buildAgent(db, typedCfg({ image: true }), tools, new Logger('error'));
		expect(agent).not.toBeNull();
		const names = tools.map((t) => t.name);
		expect(names).toContain('llm_gen_image');
		expect(names).not.toContain('llm_gen_video');
		expect(names).not.toContain('llm_code'); // no coding model in this config
	});

	test('use_same_models exposes no llm_* tools at all', async () => {
		const c = withKey(loadConfig('example.config.toml'));
		c.agent.models.use_same_models = true;
		const tools: Tool[] = [];
		buildAgent(db, c, tools, new Logger('error'));
		expect(tools.map((t) => t.name).filter((n) => n.startsWith('llm_'))).toEqual([]);
	});

	test('a configured video model exposes llm_gen_video with a prompt cap', async () => {
		const tools: Tool[] = [];
		buildAgent(db, typedCfg({ video: true }), tools, new Logger('error'));
		const gen = tools.find((t) => t.name === 'llm_gen_video');
		expect(gen).toBeDefined();
		expect(gen!.parameters?.required).toEqual(['prompt']);
		// empty / oversized prompts die before any provider call
		await expect(gen!.invoker({ prompt: '' })).rejects.toThrow('prompt must be');
		await expect(gen!.invoker({ prompt: 'x'.repeat(4_001) })).rejects.toThrow('prompt must be');
	});
});

describe('dedicated coding model routing', () => {
	async function buildAndInspect(c: AppConfig): Promise<{ tools: Tool[]; agent: NonNullable<Awaited<ReturnType<typeof buildAgent>>> }> {
		const tools: Tool[] = [];
		const agent = buildAgent(db, c, tools, new Logger('error'));
		expect(agent).not.toBeNull();
		return { tools, agent: agent! };
	}

	test('with a coding model the default stays master and llm_code exists', async () => {
		const { tools, agent } = await buildAndInspect(typedCfg({ coding: true }));
		expect(tools.map((t) => t.name)).toContain('llm_code');
		const brain = agent as unknown as { dedicatedCodingModel: boolean; routeModel: (p: string, forced?: string) => string };
		expect(brain.dedicatedCodingModel).toBe(true);
		// code-looking prompts no longer hand the whole conversation away
		expect(brain.routeModel('write a python function to sort a list')).toBe('default');
		// an explicit choice still wins
		expect(brain.routeModel('anything', 'coding')).toBe('coding');
	});

	test('without one the code-looking heuristic still routes (coding = same model)', async () => {
		const { tools, agent } = await buildAndInspect(typedCfg({ image: true }));
		expect(tools.map((t) => t.name)).not.toContain('llm_code');
		const brain = agent as unknown as { dedicatedCodingModel: boolean; routeModel: (p: string, forced?: string) => string };
		expect(brain.dedicatedCodingModel).toBe(false);
		expect(brain.routeModel('def hello(): pass')).toBe('coding');
		expect(brain.routeModel('salut ca va?')).toBe('default');
	});
});
