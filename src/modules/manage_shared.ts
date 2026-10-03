// Agent self-management, shared half: the pieces manage_tool and manage_skill
// both need (name rules, directory resolution, the write/rollback helpers, the
// audit hook and the one-mutation-at-a-time chain).
//
// Security model for both halves:
// - names are strict (^[a-z][a-z0-9_]{1,63}$), the file path is a join of the
//   configured directory and `<name>.<ext>`: no separators, no `..`, no way to
//   reach outside the configured tool/skill directory
// - a tool body is syntax-checked with the real TooLang parser BEFORE the file
//   is written, a skill is parsed with the real skill parser BEFORE the file is
//   written: a rejected write never exists, a written file always loads
// - writes are size-capped and the directory has a file cap, so the model can
//   never fill the disk or replace the registry with 10k tools
// - protected skills (TOOLANG.md) refuse create/edit/delete with a clear error
// - every mutation is audit-logged (actor: agent) and serialized so two
//   concurrent calls cannot interleave read-modify-write
// - edits are rolled back if the reloaded registry would lose the entry

import { readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { AppConfig } from '../utils/config.js';
import type DB from '../db/struct.js';
import { ToolRegistry } from './tools.js';
import { SkillRegistry } from './skills.js';
import { ModuleError } from './types.js';

/** Shared name rule: also what the tool/skill registries enforce on load. */
export const NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

export interface ManageDeps {
	config: AppConfig;
	tools: ToolRegistry;
	skills: SkillRegistry;
	db: DB;
	log: (level: 'info' | 'warn' | 'error', message: string) => void;
	/** function names already owned by addons (no .tl tool may shadow them) */
	reservedNames?: string[];
}

/** One mutation at a time: create/edit/delete are read-modify-write. */
let chain: Promise<unknown> = Promise.resolve();
export function serialize<T>(fn: () => Promise<T>): Promise<T> {
	const next = chain.then(fn, fn);
	chain = next.catch(() => undefined);
	return next;
}

/** Strip control chars (keep newlines) so nothing weird lands in a file. */
export function cleanText(value: unknown, field: string, cap: number, allowNewlines = false): string {
	const raw = typeof value === 'string' ? value : '';
	const text = allowNewlines ? raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') : raw.replace(/[\x00-\x1f\x7f]/g, ' ');
	const out = text.trim().slice(0, cap);
	if (out.length === 0) throw new ModuleError(`manage: ${field} must not be empty`);
	return out;
}

export function existsDir(dir: string): boolean {
	try {
		return statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/** The first configured directory: where new files are written. */
export function firstDir(dirs: string[], kind: string): string {
	const dir = path.resolve(dirs[0] ?? '');
	if (!dirs[0] || !existsDir(dir)) throw new ModuleError(`manage: ${kind} directory '${dirs[0] ?? '(unset)'}' does not exist`);
	return dir;
}

export function countFiles(dir: string, ext: string): number {
	try {
		return readdirSync(dir).filter((f) => f.endsWith(ext)).length;
	} catch {
		return 0;
	}
}

export function filePathOf(dir: string, name: string, ext: string): string {
	// NAME_RE has no path separators: this join can never leave `dir`
	return path.join(dir, `${name}${ext}`);
}

export function isFile(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

export function mustExist(file: string, name: string, kind: string): void {
	if (!existsDir(path.dirname(file))) throw new ModuleError(`manage: ${kind} directory is gone`);
	try {
		statSync(file);
	} catch {
		throw new ModuleError(`manage: ${kind} '${name}' does not exist`);
	}
}

export async function audit(db: DB, action: string, target: string): Promise<void> {
	try {
		await db.audit({ actor_id: 'agent', action, target: target.slice(0, 64), details: '{}' });
	} catch {
		/* audit must never block a mutation that already happened */
	}
}
