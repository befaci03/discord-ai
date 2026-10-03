// manage_skill: create/edit/delete one of the agent's own markdown skills.
// Gated by [agent.toolang].allow_skill_creation, validated with the real
// skill parser BEFORE the file is written, and TOOLANG.md is protected.

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { ModuleError } from './types.js';
import { SkillRegistry, PROTECTED_SKILLS, parseSkillSource } from './skills.js';
import { ManageDeps, NAME_RE, audit, cleanText, countFiles, filePathOf, firstDir, isFile, mustExist, serialize } from './manage_shared.js';

const MAX_SKILL_BYTES = 256_000;
const MAX_SKILLS_PER_DIR = 150;
const MAX_TRIGGERS = 75;

function tomlStr(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

function normTriggers(raw: unknown): string[] {
	let list: unknown[] = [];
	if (Array.isArray(raw)) list = raw;
	else if (typeof raw === 'string') list = raw.split(',');
	else throw new ModuleError('manage_skill: triggers must be a list (or comma-separated string)');
	const out = list
		.map((t) => String(t).trim())
		.filter((t) => t.length > 0)
		.map((t) => t.slice(0, 100));
	if (out.length === 0) throw new ModuleError('manage_skill: at least one trigger is required');
	if (out.length > MAX_TRIGGERS) throw new ModuleError(`manage_skill: at most ${MAX_TRIGGERS} triggers`);
	// /.../ triggers are regular expressions, and every message runs against
	// them: a hand-written skill may use them (operator choice), but a trigger
	// the model just wrote must not reach a backtracking engine (ReDoS)
	for (const t of out) {
		if (t.startsWith('/') && t.endsWith('/') && t.length > 2) {
			throw new ModuleError('manage_skill: regex triggers (/.../) are not allowed in created skills, use plain words or substrings');
		}
	}
	return out;
}

function normSkillTools(raw: unknown): string[] {
	if (raw === undefined || raw === null || raw === '') return [];
	const list = Array.isArray(raw) ? raw : String(raw).split(',');
	const out = list
		.map((t) => String(t).trim())
		.filter(Boolean)
		.map((t) => t.slice(0, 64));
	if (out.length > 20) throw new ModuleError('manage_skill: at most 20 recommended tools');
	return out;
}

function buildSkillSource(meta: { name: string; description: string; triggers: string[]; tools: string[]; priority: number }, instructions: string): string {
	const lines = [`name = ${tomlStr(meta.name)}`, `description = ${tomlStr(meta.description)}`, `triggers = [${meta.triggers.map(tomlStr).join(', ')}]`];
	if (meta.tools.length > 0) lines.push(`tools = [${meta.tools.map(tomlStr).join(', ')}]`);
	lines.push(`priority = ${meta.priority}`);
	return `---\n${lines.join('\n')}\n---\n\n${instructions}\n`;
}

export async function runManageSkill(deps: ManageDeps, args: Record<string, unknown>): Promise<unknown> {
	if (deps.config.agent.toolang.allowSkillCreation !== true) {
		throw new ModuleError('manage_skill: disabled (set agent.toolang.allow_skill_creation = true in config.toml)');
	}
	const action = String(args.action ?? '').trim();
	if (!['create', 'edit', 'delete'].includes(action)) throw new ModuleError('manage_skill: action must be create|edit|delete');
	const name = String(args.name ?? '').trim();
	if (!NAME_RE.test(name)) throw new ModuleError('manage_skill: name must be lowercase letters, digits or underscores, start with a letter and be under 64 chars');
	if (PROTECTED_SKILLS.includes(name)) {
		throw new ModuleError(`manage_skill: '${name}' is protected (${name}.md is the built-in reference and cannot be changed)`);
	}
	if (deps.config.skills.disabled.includes(name)) {
		throw new ModuleError(`manage_skill: '${name}' is in [skills] disabled in config.toml`);
	}
	const dir = firstDir(deps.config.skills.directories, 'skill');
	const file = filePathOf(dir, name, '.md');

	return await serialize(async () => {
		const exists = isFile(file);
		if (action === 'delete') {
			mustExist(file, name, 'skill');
			unlinkSync(file);
			deps.skills.loadAll();
			await audit(deps.db, 'skill.delete', name);
			deps.log('warn', `agent deleted skill '${name}'`);
			return { action, name, deleted: true, note: 'the skill is no longer loaded' };
		}
		if (action === 'create' && exists) throw new ModuleError(`manage_skill: '${name}' already exists (use edit)`);
		if (action === 'edit' && !exists) throw new ModuleError(`manage_skill: '${name}' does not exist (use create)`);
		if (action === 'create' && countFiles(dir, '.md') >= MAX_SKILLS_PER_DIR) {
			throw new ModuleError(`manage_skill: directory is full (${MAX_SKILLS_PER_DIR} skills)`);
		}

		// edits keep whatever the model did not send: start from the old file
		let description = '';
		let triggers: string[] = [];
		let tools: string[] = [];
		let priority = 0;
		let instructions = '';
		if (exists) {
			const parsed = parseSkillSource(readFileSync(file, 'utf-8'), file);
			description = parsed.description;
			triggers = parsed.triggers;
			tools = parsed.tools;
			priority = parsed.priority;
			instructions = parsed.instructions;
		}
		if (args.description !== undefined) description = cleanText(args.description, 'description', 300);
		if (args.triggers !== undefined) triggers = normTriggers(args.triggers);
		if (args.tools !== undefined) tools = normSkillTools(args.tools);
		if (args.priority !== undefined) {
			const p = Number(args.priority);
			if (!Number.isFinite(p)) throw new ModuleError('manage_skill: priority must be a number');
			priority = Math.min(Math.max(Math.round(p), -100), 100);
		}
		if (args.instructions !== undefined) instructions = cleanText(args.instructions, 'instructions', MAX_SKILL_BYTES, true);
		if (description.length === 0) throw new ModuleError('manage_skill: description is required');
		if (triggers.length === 0) throw new ModuleError('manage_skill: at least one trigger is required');
		if (instructions.length === 0) throw new ModuleError('manage_skill: instructions are required');

		const source = buildSkillSource({ name, description, triggers, tools, priority }, instructions);
		if (Buffer.byteLength(source, 'utf-8') > MAX_SKILL_BYTES) throw new ModuleError(`manage_skill: skill is larger than ${MAX_SKILL_BYTES} bytes`);
		// parse with the real loader BEFORE touching disk
		parseSkillSource(source, file);

		const before = exists ? readFileSync(file, 'utf-8') : null;
		writeFileSync(file, source, 'utf-8');
		deps.skills.loadAll();
		if (!deps.skills.get(name)) {
			if (before === null) unlinkSync(file);
			else writeFileSync(file, before, 'utf-8');
			deps.skills.loadAll();
			throw new ModuleError(`manage_skill: '${name}' was rejected by the registry, write rolled back`);
		}
		await audit(deps.db, action === 'create' ? 'skill.create' : 'skill.edit', name);
		deps.log('info', `agent ${action === 'create' ? 'created' : 'edited'} skill '${name}'`);
		return {
			action,
			name,
			description,
			triggers,
			priority,
			enabled: deps.skills.isEnabled(name),
			note: 'loaded: its instructions are injected when a message hits one of the triggers'
		};
	});
}
