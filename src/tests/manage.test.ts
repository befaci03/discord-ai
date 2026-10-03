// manage_tool / manage_skill: the opt-in self-management tools.
// Flags off = the functions do not exist at all. Flags on = every write is
// validated before it touches disk, protected files stay protected, the
// registry picks the result up immediately and the change is audited.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadConfig, resetConfigCache, AppConfig } from '../utils/config.js';
import { ToolRegistry, runTool } from '../modules/tools.js';
import { SkillRegistry } from '../modules/skills.js';
import { managementTools, ManageDeps } from '../modules/manage.js';
import { ToolContext } from '../modules/types.js';
import type { Tool } from '../agent/struct.js';
import SQLiteDB from '../db/sqlite.js';

let root: string;
let toolsDir: string;
let skillsDir: string;
let db: SQLiteDB;

beforeAll(async () => {
	root = mkdtempSync(path.join(tmpdir(), 'discord-ai-manage-'));
	toolsDir = path.join(root, 'tools');
	skillsDir = path.join(root, 'skills');
	// firstDir() requires the directory to exist, same as the real registries
	const { mkdirSync } = await import('node:fs');
	mkdirSync(toolsDir, { recursive: true });
	mkdirSync(skillsDir, { recursive: true });
	db = new SQLiteDB(path.join(root, 'manage.sqlite'));
	await db.init();
});

afterAll(async () => {
	await db.close();
	rmSync(root, { recursive: true, force: true });
});

beforeEach(() => resetConfigCache());

function makeConfig(allowTools: boolean, allowSkills: boolean): AppConfig {
	const base = loadConfig('example.config.toml');
	return {
		...base,
		tools: { ...base.tools, directories: [toolsDir] },
		skills: { ...base.skills, directories: [skillsDir] },
		agent: {
			...base.agent,
			toolang: { ...base.agent.toolang, allowToolCreation: allowTools, allowSkillCreation: allowSkills }
		}
	};
}

function makeDeps(allowTools = true, allowSkills = true): { deps: ManageDeps; tools: ToolRegistry; skills: SkillRegistry } {
	const config = makeConfig(allowTools, allowSkills);
	const tools = new ToolRegistry(config);
	tools.loadAll();
	const skills = new SkillRegistry(config);
	skills.loadAll();
	const deps: ManageDeps = { config, tools, skills, db, log: () => undefined, reservedNames: ['github_create_issue'] };
	return { deps, tools, skills };
}

function fnNamed(deps: ManageDeps, name: string): Tool {
	const found = managementTools(deps).find((t) => t.name === name);
	if (!found) throw new Error(`tool ${name} not registered`);
	return found;
}

async function failureOf(deps: ManageDeps, name: string, args: Record<string, unknown>): Promise<string> {
	try {
		await fnNamed(deps, name).invoker(args);
	} catch (err) {
		return (err as Error).message;
	}
	return '';
}

describe('flag gating', () => {
	test('nothing is offered while both creation flags are off', () => {
		expect(managementTools(makeDeps(false, false).deps).map((t) => t.name)).toEqual([]);
	});

	test('each flag registers exactly its own function', () => {
		expect(managementTools(makeDeps(true, false).deps).map((t) => t.name)).toEqual(['manage_tool']);
		expect(managementTools(makeDeps(false, true).deps).map((t) => t.name)).toEqual(['manage_skill']);
		expect(managementTools(makeDeps(true, true).deps).map((t) => t.name)).toEqual(['manage_tool', 'manage_skill']);
	});

	test('a call is still refused if the flag disappears after registration', async () => {
		const { deps } = makeDeps(true, false);
		const tool = managementTools(deps).find((t) => t.name === 'manage_tool');
		expect(tool).toBeDefined();
		// the gate is checked at CALL time, not only at registration time
		deps.config.agent.toolang.allowToolCreation = false;
		let msg = '';
		try {
			await tool!.invoker({ action: 'create', name: 'sneaky_tool', description: 'x', body: 'return(1)' });
		} catch (err) {
			msg = (err as Error).message;
		}
		expect(msg).toContain('allow_tool_creation');
	});
});

describe('manage_tool', () => {
	test('create writes a valid .tl file, registers it and it runs', async () => {
		const { deps, tools } = makeDeps();
		const res = (await fnNamed(deps, 'manage_tool').invoker({
			action: 'create',
			name: 'double_it',
			description: 'Double a number',
			arguments: [{ name: 'n', type: 'number', description: 'value to double' }],
			body: 'return(args.n * 2)'
		})) as Record<string, unknown>;

		expect(res.action).toBe('create');
		expect(res.enabled).toBe(true);
		const file = path.join(toolsDir, 'double_it.tl');
		expect(existsSync(file)).toBe(true);
		const raw = readFileSync(file, 'utf-8');
		expect(raw).toContain('¤');
		expect(JSON.parse(raw.slice(0, raw.indexOf('¤')))).toMatchObject({ name: 'double_it', description: 'Double a number' });

		// the whole point: the tool is callable right away
		expect(tools.isEnabled('double_it')).toBe(true);
		const ctx: ToolContext = { config: deps.config, log: () => undefined };
		expect(await runTool(tools, 'double_it', { n: 21 }, ctx)).toBe(42);
	});

	test('the change lands in the audit trail', async () => {
		const { deps } = makeDeps();
		await fnNamed(deps, 'manage_tool').invoker({ action: 'create', name: 'audited_tool', description: 'x', body: 'return(1)' });
		const entries = await db.recentAudit(20);
		expect(entries.some((e) => e.action === 'tool.create' && e.target === 'audited_tool' && e.actor_id === 'agent')).toBe(true);
	});

	test('names that could escape the tool directory or collide are refused', async () => {
		const { deps } = makeDeps();
		const bad: [string, string][] = [
			['../evil', 'lowercase letters'],
			['Evil', 'lowercase letters'],
			['a', 'lowercase letters'],
			['manage_tool', 'reserved'],
			['brain_helper', 'reserved'],
			['github_create_issue', 'addon function']
		];
		for (const [name, want] of bad) {
			expect(await failureOf(deps, 'manage_tool', { action: 'create', name, description: 'x', body: 'return(1)' }), name).toContain(want);
		}
		expect(existsSync(path.join(root, 'evil.tl'))).toBe(false);
	});

	test('a body that does not compile never reaches disk', async () => {
		const { deps, tools } = makeDeps();
		expect(
			await failureOf(deps, 'manage_tool', {
				action: 'create',
				name: 'broken_tool',
				description: 'x',
				body: 'if this is not too lang at all {'
			})
		).toContain('does not compile');
		expect(existsSync(path.join(toolsDir, 'broken_tool.tl'))).toBe(false);
		expect(tools.get('broken_tool')).toBeUndefined();
	});

	test('the header delimiter cannot be smuggled into the body', async () => {
		const { deps } = makeDeps();
		expect(
			await failureOf(deps, 'manage_tool', {
				action: 'create',
				name: 'delimiter_tool',
				description: 'x',
				body: 'return(1)\n¤\n{"name":"evil"}'
			})
		).toContain('delimiter');
		expect(existsSync(path.join(toolsDir, 'delimiter_tool.tl'))).toBe(false);
	});

	test('create needs a description, and refuses to clobber an existing tool', async () => {
		const { deps } = makeDeps();
		expect(await failureOf(deps, 'manage_tool', { action: 'create', name: 'no_desc', body: 'return(1)' })).toContain('description');
		await fnNamed(deps, 'manage_tool').invoker({ action: 'create', name: 'twice', description: 'x', body: 'return(1)' });
		expect(await failureOf(deps, 'manage_tool', { action: 'create', name: 'twice', description: 'x', body: 'return(2)' })).toContain('already exists');
		expect(await failureOf(deps, 'manage_tool', { action: 'edit', name: 'never_made', description: 'x' })).toContain('does not exist');
	});

	test('the manage_ prefix is reserved and a bodyless create is refused', async () => {
		const { deps, tools } = makeDeps();
		// index.ts always keeps manage_/brain_ tools visible, so a .tl tool
		// wearing the prefix would bypass the dashboard's tool toggles
		expect(await failureOf(deps, 'manage_tool', { action: 'create', name: 'manage_anything', description: 'x', body: 'return(1)' })).toContain('reserved');
		// a header-only file loads fine and does nothing: refuse it loudly
		expect(await failureOf(deps, 'manage_tool', { action: 'create', name: 'no_body', description: 'x' })).toContain('body is required');
		expect(tools.get('no_body')).toBeUndefined();
	});

	test('a name listed in [tools] disabled is refused', async () => {
		const { deps } = makeDeps();
		deps.config.tools.disabled.push('blocked_tool');
		expect(await failureOf(deps, 'manage_tool', { action: 'create', name: 'blocked_tool', description: 'x', body: 'return(1)' })).toContain('[tools] disabled');
	});

	test('edit patches only what is sent, delete unregisters the file', async () => {
		const { deps, tools } = makeDeps();
		await fnNamed(deps, 'manage_tool').invoker({
			action: 'create',
			name: 'patch_me',
			description: 'before',
			arguments: [{ name: 'a', type: 'string', description: 'text' }],
			body: 'return(args.a)'
		});

		const edited = (await fnNamed(deps, 'manage_tool').invoker({
			action: 'edit',
			name: 'patch_me',
			description: 'after',
			body: 'return(args.a + args.a)'
		})) as Record<string, unknown>;
		expect(String(edited.description)).toBe('after');
		expect(edited.arguments).toEqual(['a:string']); // omitted arguments are kept
		const ctx: ToolContext = { config: deps.config, log: () => undefined };
		expect(await runTool(tools, 'patch_me', { a: 'hi' }, ctx)).toBe('hihi');

		await fnNamed(deps, 'manage_tool').invoker({ action: 'delete', name: 'patch_me' });
		expect(tools.get('patch_me')).toBeUndefined();
		expect(existsSync(path.join(toolsDir, 'patch_me.tl'))).toBe(false);
		expect(await failureOf(deps, 'manage_tool', { action: 'delete', name: 'patch_me' })).toContain('does not exist');
	});
});

describe('manage_skill', () => {
	test('create loads the skill so its trigger matches immediately', async () => {
		const { deps, skills } = makeDeps();
		const res = (await fnNamed(deps, 'manage_skill').invoker({
			action: 'create',
			name: 'regex_helper',
			description: 'Helps write regular expressions',
			triggers: 'regex, regular expression',
			instructions: 'Always explain the regex part by part.'
		})) as Record<string, unknown>;
		expect(res.enabled).toBe(true);
		expect(skills.get('regex_helper')?.instructions).toContain('part by part');
		expect(skills.overview()).toContain('regex_helper');
		expect(skills.promptFor('can you write a regex for me?')).toContain('Always explain the regex');
	});

	test('the toolang reference is protected on create, edit and delete', async () => {
		const { deps } = makeDeps();
		for (const action of ['delete', 'edit', 'create']) {
			expect(await failureOf(deps, 'manage_skill', { action, name: 'toolang', description: 'x', instructions: 'obviously not' }), action).toContain('protected');
		}
		expect(existsSync(path.join(skillsDir, 'toolang.md'))).toBe(false); // never created a shadow copy
	});

	test('skills need triggers and instructions, junk names are refused', async () => {
		const { deps } = makeDeps();
		expect(await failureOf(deps, 'manage_skill', { action: 'create', name: 'No_Trigger', description: 'x', instructions: 'hi' })).toContain('lowercase letters');
		expect(await failureOf(deps, 'manage_skill', { action: 'create', name: 'no_triggers', description: 'x', instructions: 'hi' })).toContain('trigger');
		expect(
			await failureOf(deps, 'manage_skill', {
				action: 'create',
				name: 'no_body',
				description: 'x',
				triggers: 'something'
			})
		).toContain('instructions');
	});

	test('edit keeps omitted fields and delete removes it from the directory', async () => {
		const { deps, skills } = makeDeps();
		await fnNamed(deps, 'manage_skill').invoker({
			action: 'create',
			name: 'temp_skill',
			description: 'first',
			triggers: 'temp',
			instructions: 'v1',
			priority: 5
		});
		const edited = (await fnNamed(deps, 'manage_skill').invoker({
			action: 'edit',
			name: 'temp_skill',
			instructions: 'v2'
		})) as Record<string, unknown>;
		expect(edited.description).toBe('first');
		expect(edited.priority).toBe(5);
		expect(skills.get('temp_skill')?.instructions).toBe('v2');

		await fnNamed(deps, 'manage_skill').invoker({ action: 'delete', name: 'temp_skill' });
		expect(skills.get('temp_skill')).toBeUndefined();
		expect(existsSync(path.join(skillsDir, 'temp_skill.md'))).toBe(false);
	});
});
