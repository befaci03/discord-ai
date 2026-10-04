// manage_tool: create/edit/delete one of the agent's own .tl tools.
// Gated by [agent.toolang].allow_tool_creation (checked here at call time as
// well as at registration), validated with the real parser before any write.

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { ToolDef } from '../utils/llmproto/types.js';
import { ArgDef } from '../utils/llmproto/types.js';
import { parseToolSource } from '../utils/toolang/index.js';
import { Lexer } from '../utils/toolang/lexer.js';
import { Parser } from '../utils/toolang/parser.js';
import { ModuleError } from './types.js';
import { ManageDeps, NAME_RE, audit, cleanText, countFiles, filePathOf, firstDir, isFile, mustExist, serialize } from './manage_shared.js';

const ARG_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const ARG_TYPES = new Set(['string', 'number', 'boolean']);
const MAX_ARGS = 30;
const MAX_TOOL_BYTES = 172_000;
const MAX_DESC = 1000;
const MAX_TOOLS_PER_DIR = 400;
/** names that must stay under operator control (agent-native) */
const RESERVED = new Set(['manage_tool', 'manage_skill']);

/** Accepts an array of objects, a JSON string, or "name:type:desc" strings. */
function normArgDefs(raw: unknown): ArgDef[] {
	let list: unknown[] = [];
	if (raw === undefined || raw === null || raw === '') list = [];
	else if (Array.isArray(raw)) list = raw;
	else if (typeof raw === 'string') {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			throw new ModuleError(`manage_tool: arguments must be an array (or its JSON form): ${(err as Error).message}`);
		}
		if (!Array.isArray(parsed)) throw new ModuleError('manage_tool: arguments JSON must be an array');
		list = parsed;
	} else {
		throw new ModuleError('manage_tool: arguments must be an array of {name, type, description}');
	}
	if (list.length > MAX_ARGS) throw new ModuleError(`manage_tool: at most ${MAX_ARGS} arguments`);
	const out: ArgDef[] = [];
	const seen = new Set<string>();
	for (const item of list) {
		let name: string;
		let type: string;
		let description: string;
		let disallow: string[] = [];
		let optional = false;
		if (typeof item === 'string') {
			// convenience shorthand: "name:type:description"
			const parts = item.split(':');
			name = (parts[0] ?? '').trim();
			type = (parts[1] ?? 'string').trim();
			description = parts.slice(2).join(':').trim();
		} else if (item && typeof item === 'object' && !Array.isArray(item)) {
			const o = item as Record<string, unknown>;
			name = String(o.name ?? '').trim();
			type = String(o.type ?? 'string').trim();
			description = String(o.description ?? '').trim();
			if (Array.isArray(o.disallow))
				disallow = o.disallow
					.map(String)
					.map((s) => s.slice(0, 64))
					.slice(0, 10);
			// strict boolean, like every other capability switch: a stray string
			// must never turn an argument optional (or required) by accident
			optional = o.optional === true;
		} else {
			throw new ModuleError("manage_tool: each argument must be an object or a 'name:type:description' string");
		}
		if (!ARG_NAME_RE.test(name)) throw new ModuleError(`manage_tool: invalid argument name '${name.slice(0, 40)}'`);
		if (seen.has(name)) throw new ModuleError(`manage_tool: duplicate argument '${name}'`);
		if (!ARG_TYPES.has(type)) throw new ModuleError(`manage_tool: argument '${name}' has unknown type '${type.slice(0, 20)}' (string|number|boolean)`);
		seen.add(name);
		out.push({ name, type: type as ArgDef['type'], description: description.slice(0, 300), disallow, ...(optional ? { optional: true } : {}) });
	}
	return out;
}

function normBody(raw: unknown): string {
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		throw new ModuleError('manage_tool: body must be the TooLang program (everything after the ¤ delimiter)');
	}
	const body = raw.trim();
	if (body.includes('¤')) throw new ModuleError('manage_tool: body must not contain the ¤ header delimiter');
	if (Buffer.byteLength(body, 'utf-8') > MAX_TOOL_BYTES) {
		throw new ModuleError(`manage_tool: body is larger than ${MAX_TOOL_BYTES} bytes`);
	}
	try {
		new Parser(new Lexer(body).tokenize()).parse();
	} catch (err) {
		throw new ModuleError(`manage_tool: body does not compile: ${(err as Error).message}`);
	}
	return body;
}

function buildToolSource(header: ToolDef, body: string): string {
	return `${JSON.stringify(header, null, '\t')}¤\n\n${body}\n`;
}

function checkToolName(nameRaw: unknown): string {
	const name = String(nameRaw ?? '').trim();
	if (!NAME_RE.test(name)) throw new ModuleError('manage_tool: name must be lowercase letters, digits or underscores, start with a letter and be under 64 chars');
	// manage_* too: index.ts's tool filter always keeps manage_/brain_ tools
	// visible, so a .tl tool wearing that prefix would bypass dashboard toggles
	if (RESERVED.has(name) || name.startsWith('brain_') || name.startsWith('manage_')) {
		throw new ModuleError(`manage_tool: '${name}' is reserved (brain_* and manage_* stay under operator control)`);
	}
	return name;
}

export async function runManageTool(deps: ManageDeps, args: Record<string, unknown>): Promise<unknown> {
	if (deps.config.agent.toolang.allowToolCreation !== true) {
		throw new ModuleError('manage_tool: disabled (set agent.toolang.allow_tool_creation = true in config.toml)');
	}
	const action = String(args.action ?? '').trim();
	if (!['create', 'edit', 'delete'].includes(action)) throw new ModuleError('manage_tool: action must be create|edit|delete');
	const name = checkToolName(args.name);
	const reserved = new Set([...(deps.reservedNames ?? [])]);
	if (reserved.has(name)) throw new ModuleError(`manage_tool: '${name}' is used by an addon function`);
	if (deps.config.tools.disabled.includes(name)) {
		throw new ModuleError(`manage_tool: '${name}' is in [tools] disabled in config.toml`);
	}
	const dir = firstDir(deps.config.tools.directories, 'tool');
	const file = filePathOf(dir, name, '.tl');

	return await serialize(async () => {
		const exists = isFile(file);
		if (action === 'delete') {
			mustExist(file, name, 'tool');
			unlinkSync(file);
			deps.tools.loadAll();
			await audit(deps.db, 'tool.delete', name);
			deps.log('warn', `agent deleted tool '${name}'`);
			return { action, name, deleted: true, note: 'the tool is no longer registered' };
		}
		if (action === 'create' && exists) throw new ModuleError(`manage_tool: '${name}' already exists (use edit)`);
		if (action === 'edit' && !exists) throw new ModuleError(`manage_tool: '${name}' does not exist (use create)`);
		if (action === 'create' && countFiles(dir, '.tl') >= MAX_TOOLS_PER_DIR) {
			throw new ModuleError(`manage_tool: directory is full (${MAX_TOOLS_PER_DIR} tools)`);
		}

		// start from the existing file for edits, so omitted fields are kept
		let header: ToolDef = { name, description: '', arguments: [] };
		let body = '';
		if (exists) {
			const parsed = parseToolSource(readFileSync(file, 'utf-8'));
			header = parsed.header;
			body = parsed.code;
		}
		if (args.description !== undefined) header.description = cleanText(args.description, 'description', MAX_DESC);
		if (args.arguments !== undefined) header.arguments = normArgDefs(args.arguments);
		if (args.body !== undefined) body = normBody(args.body);
		header.name = name;
		if (header.description.length === 0) throw new ModuleError('manage_tool: description is required (the model reads it to pick tools)');
		if (!Array.isArray(header.arguments)) header.arguments = [];
		// a header-only file loads fine and does nothing: refuse it loudly
		// instead of handing the model a tool that silently returns null
		if (action === 'create' && body.trim().length === 0) {
			throw new ModuleError('manage_tool: body is required (the TooLang program that runs when the tool is called)');
		}

		const source = buildToolSource(header, body);
		const before = exists ? readFileSync(file, 'utf-8') : null;
		writeFileSync(file, source, 'utf-8');
		deps.tools.loadAll();
		if (!deps.tools.get(name)) {
			// rollback: never leave a file the registry refuses to load
			if (before === null) unlinkSync(file);
			else writeFileSync(file, before, 'utf-8');
			deps.tools.loadAll();
			throw new ModuleError(`manage_tool: '${name}' was rejected by the registry, write rolled back`);
		}
		await audit(deps.db, action === 'create' ? 'tool.create' : 'tool.edit', name);
		deps.log('info', `agent ${action === 'create' ? 'created' : 'edited'} tool '${name}'`);
		return {
			action,
			name,
			description: header.description,
			arguments: header.arguments.map((a) => `${a.name}:${a.type}`),
			enabled: deps.tools.isEnabled(name),
			note: 'registered and callable now (it shows up in your tool list from the next message on)'
		};
	});
}
