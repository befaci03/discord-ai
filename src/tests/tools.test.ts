// The .tl tools the model sees: header args become JSON schema, disabled tools
// stay invisible, and every docker op dies at the [docker].enabled gate.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadConfig, resetConfigCache, AppConfig } from '../utils/config.js';
import { ToolRegistry, runTool } from '../modules/tools.js';
import { ToolContext } from '../modules/types.js';
import { buildAgent, llmAvailable, registryToAgentTools, readPromptFile } from '../agent/factory.js';
import { validateToolArgs, fillOptionalDefaults, parseToolSource } from '../utils/toolang/index.js';
import type { ToolDef } from '../utils/llmproto/types.js';
import SQLiteDB from '../db/sqlite.js';
import { Logger } from '../utils/logger.js';

let dir: string;
let db: SQLiteDB;
let config: AppConfig;
let registry: ToolRegistry;
let ctx: ToolContext;

beforeAll(async () => {
	dir = mkdtempSync(path.join(tmpdir(), 'discord-ai-tools-'));
	db = new SQLiteDB(path.join(dir, 'tools.sqlite'));
	await db.init();
});

afterAll(async () => {
	await db.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	resetConfigCache();
	// the example ships [docker].enabled = false, which is the interesting case
	config = loadConfig('example.config.toml');
	registry = new ToolRegistry(config);
	registry.loadAll();
	ctx = { config, log: () => undefined };
});

async function failureOf(name: string, args: Record<string, unknown>): Promise<string> {
	try {
		await runTool(registry, name, args, ctx);
	} catch (err) {
		return (err as Error).message;
	}
	return '';
}

describe('tool discovery', () => {
	test('docker tools ship next to the regular ones', () => {
		expect(registry.names()).toEqual(expect.arrayContaining(['fetch_json', 'web_search', 'server_stats', 'sandbox_write', 'docker_list', 'docker_exec', 'docker_create', 'docker_manage']));
	});
});

describe('LLM exposure', () => {
	test('header arguments become a JSON schema with every arg required', () => {
		const defs = registryToAgentTools(registry, ctx, db);
		const fetch = defs.find((d) => d.name === 'fetch_json');
		expect(fetch?.parameters).toEqual({
			type: 'object',
			properties: { url: { type: 'string', description: 'The URL to fetch (must be http/https)' } },
			required: ['url']
		});
		// a tool with several header args keeps them all required
		const write = defs.find((d) => d.name === 'sandbox_write');
		expect((write?.parameters?.required ?? []) as string[]).toEqual(['path', 'content', 'append']);
	});

	test("optional header args stay out of the schema's required list", () => {
		// docker tools are hidden while docker is off: turn it on for this check
		config.docker.enabled = true;
		const defs = registryToAgentTools(registry, ctx, db);
		// docker_manage's volume args are optional: the model must NOT be forced
		// to pass them for a plain start/stop
		const manage = defs.find((d) => d.name === 'docker_manage');
		expect(manage?.parameters?.required).toEqual(['container', 'action']);
		const props = (manage?.parameters?.properties ?? {}) as Record<string, unknown>;
		expect(props.volume).toBeDefined();
		expect(props.volume_path).toBeDefined();
		const create = defs.find((d) => d.name === 'docker_create');
		expect(create?.parameters?.required).toEqual(['name', 'image', 'port']);
	});

	test('docker tools are hidden while [docker].enabled is false', () => {
		const hidden = registryToAgentTools(registry, ctx, db).map((d) => d.name);
		expect(hidden).not.toContain('docker_list');
		expect(hidden).toContain('fetch_json');

		config.docker.enabled = true; // ctx holds the same config object
		const shown = registryToAgentTools(registry, ctx, db);
		expect(shown.map((d) => d.name)).toEqual(expect.arrayContaining(['docker_list', 'docker_exec', 'docker_create', 'docker_manage']));
		expect(shown.find((d) => d.name === 'docker_list')?.parameters).toEqual({ type: 'object', properties: {}, required: [] });
	});

	test('disallowed values are surfaced to the model in the description', () => {
		const defs = registryToAgentTools(registry, ctx, db);
		const write = defs.find((d) => d.name === 'sandbox_write');
		const props = (write?.parameters?.properties ?? {}) as Record<string, { description?: string }>;
		expect(String(props.path?.description)).toContain('refused values');
	});

	test('a runtime-disabled tool is refused at call time', async () => {
		// the list itself is static (built at startup); per-ask hiding happens in
		// agent.toolFilter, see openai.test / brain.test. Calls are re-checked here.
		registry.setEnabled('fetch_json', false);
		expect(await failureOf('fetch_json', { url: 'http://127.0.0.1/' })).toContain('disabled');

		registry.setEnabled('fetch_json', true);
		expect(await failureOf('fetch_json', { url: 'http://127.0.0.1/' })).not.toContain('disabled');
	});

	test('the registry still refuses malformed arguments before the sandbox runs', async () => {
		expect(await failureOf('docker_exec', { container: 'web' })).toContain('Missing required argument: command');
		expect(await failureOf('docker_exec', { container: 'web', command: 42 })).toContain('must be a string');
	});
});
describe('docker gate', () => {
	test('no docker call happens while [docker].enabled is false', async () => {
		expect(config.docker.enabled).toBe(false);
		expect(await failureOf('docker_list', {})).toContain('docker is disabled');
		expect(await failureOf('docker_manage', { container: 'web', action: 'stop' })).toContain('docker is disabled');
		expect(await failureOf('docker_exec', { container: 'web', command: 'ls' })).toContain('docker is disabled');
		expect(await failureOf('docker_create', { name: 'web', image: 'nginx:alpine', port: 0 })).toContain('docker is disabled');
	});

	test('the tool itself rejects a bogus action before touching docker', async () => {
		const err = await failureOf('docker_manage', { container: 'web', action: 'bogus' });
		expect(err).toContain('action must be one of start, stop, restart, remove');
	});
});

describe('buildAgent wiring', () => {
	test('llmAvailable only reports configured when a real key + model exist', () => {
		const base = (apiKey: string, model = 'gpt-test'): AppConfig => ({
			...config,
			agent: {
				...config.agent,
				providers: { openai: { api_type: 1, base_url: 'https://api.openai.com/v1', api_key: apiKey } },
				models: { ...config.agent.models, default_model: { provider: 'openai', model } }
			}
		});
		// an unexpanded ${VAR} reference is not a key
		expect(llmAvailable(base('${OPENAI_API_KEY}'))).toBe(false);
		expect(llmAvailable(base(''))).toBe(false);
		expect(llmAvailable(base('sk-test', ''))).toBe(false);
		expect(llmAvailable(base('sk-test'))).toBe(true);
	});

	test('appends the brain tools and applies [agent.brain]', async () => {
		const cfg: AppConfig = {
			...config,
			agent: {
				...config.agent,
				providers: { openai: { api_type: 1, base_url: 'https://api.openai.com/v1', api_key: 'sk-test' } },
				models: { ...config.agent.models, default_model: { provider: 'openai', model: 'gpt-test' } }
			}
		};
		const tools = registryToAgentTools(registry, ctx, db);
		const agent = buildAgent(db, cfg, tools, new Logger('error'));
		expect(agent).not.toBeNull();
		expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['brain_set_preference', 'brain_remember_person', 'brain_get_person']));

		const brain = agent as unknown as { maxMemory: number; seed: { memory: number }; reseed: boolean; sys_prompt: string };
		expect(brain.maxMemory).toBe(cfg.agent.brain.memory);
		expect(brain.seed.memory).toBe(cfg.agent.brain.memory);
		expect(brain.reseed).toBe(false);
		expect(brain.sys_prompt.startsWith(cfg.agent.prompt)).toBe(true);
		expect(brain.sys_prompt).toContain('Your name is Agent.');
		// .prompt.txt (project root) is appended after the configured prompt
		const extra = existsSync('.prompt.txt') ? readFileSync('.prompt.txt', 'utf-8').trim() : '';
		if (extra) expect(brain.sys_prompt).toContain(extra.slice(0, 60));
	});

	test('tool rounds and output cap come from [agent], not a hardcoded 4', async () => {
		const cfg: AppConfig = {
			...config,
			agent: {
				...config.agent,
				toolRounds: 7,
				maxTokens: 1234,
				providers: { openai: { api_type: 1, base_url: 'https://api.openai.com/v1', api_key: 'sk-test' } },
				models: { ...config.agent.models, default_model: { provider: 'openai', model: 'gpt-test' } }
			}
		};
		const agent = buildAgent(db, cfg, registryToAgentTools(registry, ctx, db), new Logger('error'));
		const internals = agent as unknown as { maxToolRoundtrips: number; maxOutputTokens: number; sys_prompt: string };
		expect(internals.maxToolRoundtrips).toBe(7);
		expect(internals.maxOutputTokens).toBe(1234);
		// the strict rules ride along in the system prompt, with the real budget
		expect(internals.sys_prompt).toContain('### Operating rules (orders, not suggestions)');
		expect(internals.sys_prompt).toContain('Tool rounds per turn are limited (7)');
		expect(internals.sys_prompt).toContain('Never claim a result you did not verify');
	});

	test('the default build runs with 16 rounds and provider-chosen tokens', async () => {
		const cfg: AppConfig = {
			...config,
			agent: {
				...config.agent,
				providers: { openai: { api_type: 1, base_url: 'https://api.openai.com/v1', api_key: 'sk-test' } },
				models: { ...config.agent.models, default_model: { provider: 'openai', model: 'gpt-test' } }
			}
		};
		const agent = buildAgent(db, cfg, registryToAgentTools(registry, ctx, db), new Logger('error'));
		const internals = agent as unknown as { maxToolRoundtrips: number; maxOutputTokens: number };
		expect(internals.maxToolRoundtrips).toBe(16);
		expect(internals.maxOutputTokens).toBe(0);
	});
});

describe('persona file cap', () => {
	test('a persona file is capped at prompt_file_max_chars, short ones pass whole', () => {
		const file = path.join(dir, 'persona.txt');
		const log = new Logger('error');
		writeFileSync(file, 'x'.repeat(30_000));
		expect(readPromptFile(file, 24_000, log)).toHaveLength(24_000);
		writeFileSync(file, 'short persona');
		expect(readPromptFile(file, 24_000, log)).toBe('short persona');
		// a missing file is not an error: the bot runs without one
		expect(readPromptFile(path.join(dir, 'nope.txt'), 24_000, log)).toBe('');
	});
});

describe('optional header args', () => {
	const header: ToolDef = {
		name: 'opt_demo',
		description: '',
		arguments: [
			{ type: 'string', name: 'req', description: '', disallow: [] },
			{ type: 'string', name: 'opt', description: '', disallow: [], optional: true },
			{ type: 'number', name: 'n', description: '', disallow: [], optional: true },
			{ type: 'boolean', name: 'b', description: '', disallow: [], optional: true }
		]
	};

	test('omitted required args still fail, omitted optional ones do not', () => {
		expect(validateToolArgs(header, { req: 'a' })).toEqual([]);
		expect(validateToolArgs(header, {})).toEqual(['Missing required argument: req']);
		// provided values are type-checked exactly like required ones
		expect(validateToolArgs(header, { req: 'a', n: 'nope' })).toEqual(["Argument 'n' must be a number, got string"]);
	});

	test('the body sees the type empty default instead of undefined', () => {
		// TooLang has no undefined literal: '' / 0 / false is what a .tl script
		// can actually compare against (args.volume == "")
		expect(fillOptionalDefaults(header, { req: 'a' })).toEqual({ req: 'a', opt: '', n: 0, b: false });
		// values the caller did pass are never overwritten
		expect(fillOptionalDefaults(header, { req: 'a', opt: 'x', n: 5, b: true })).toEqual({ req: 'a', opt: 'x', n: 5, b: true });
	});

	test('the parser keeps the optional flag on a header', () => {
		const src = `{"name":"t","description":"d","arguments":[{"type":"string","name":"opt","description":"x","disallow":[],"optional":true}]}\u00a4\n\nreturn(1)`;
		const parsed = parseToolSource(src);
		expect(parsed.header.arguments[0].optional).toBe(true);
		expect(parsed.code.trim()).toBe('return(1)');
	});
});

describe('volume wiring (config to store)', () => {
	test('a volume id travels config -> tools.ts -> evaluator -> builtin and lands in <fs.root>/.docker-vols', async () => {
		// the full chain, not just the builtin: if the policy never carries
		// volumeRoot the mount dies with "unavailable", and if nobody resolves
		// the id no directory appears. The denylisted image proves the volume
		// was resolved BEFORE any docker CLI call (buildCreateArgs checks
		// volumes first), so this test never touches a real daemon.
		const sandboxRoot = path.join(dir, 'sandbox');
		const cfg: AppConfig = {
			...config,
			docker: { ...config.docker, enabled: true },
			agent: { ...config.agent, toolang: { ...config.agent.toolang, fs: { ...config.agent.toolang.fs, root: sandboxRoot } } }
		};
		const reg = new ToolRegistry(cfg);
		reg.loadAll();
		const localCtx: ToolContext = { config: cfg, log: () => undefined };
		let msg = '';
		try {
			await runTool(reg, 'docker_create', { name: 'volwired', image: 'ftp', port: 0, volume: 'wiredvol', volume_path: '' }, localCtx);
		} catch (err) {
			msg = (err as Error).message;
		}
		expect(msg).toContain('disallowed'); // volume resolved, image refused
		expect(msg).not.toContain('unavailable'); // ...with the store configured
		expect(statSync(path.join(sandboxRoot, '.docker-vols', 'wiredvol')).isDirectory()).toBe(true);
	});
});
