/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// TooLang sandboxed fs module
// Everything is jailed inside a configured sandbox root. No symlinks escaping,
// no traversal, no absolute paths. Path traversal attempts get yeeted.

import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import { RuntimeError } from '../evaluator.js';

export interface FsPolicy {
	/** absolute host directory everything must stay inside */
	root: string;
	/** max bytes for read and write */
	maxFileSize: number;
	/** allow writes (create/edit/delete), reads are always allowed inside the jail */
	allowWrite: boolean;
}

function resolveJailPath(p: string, root: string, op: string): string {
	if (typeof p !== 'string' || p.length === 0) throw new RuntimeError(`fs.${op}: path must be a non-empty string`);
	if (p.includes('\0')) throw new RuntimeError(`fs.${op}: null bytes are not allowed in paths`);
	const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
	const resolved = path.resolve(abs);
	const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
	if (!resolved.startsWith(rootWithSep)) {
		throw new RuntimeError(`fs.${op}: path escapes the sandbox, staying inside '${root}' is mandatory`);
	}
	return resolved;
}

function checkSymlinkSafe(resolved: string, root: string, op: string): void {
	// walk up from the file to the root, refusing any symlink that points outside
	let cur = resolved;
	while (cur.startsWith(root) && cur !== root) {
		let st: nodeFs.Stats;
		try {
			st = nodeFs.lstatSync(cur);
		} catch {
			// doesn't exist (yet), fine
			cur = path.dirname(cur);
			continue;
		}
		if (st.isSymbolicLink()) {
			const target = nodeFs.realpathSync(cur);
			if (!target.startsWith(root)) {
				throw new RuntimeError(`fs.${op}: symlink at '${path.relative(root, cur)}' points outside the sandbox`);
			}
		}
		cur = path.dirname(cur);
	}
}

export function fs(cfg?: Record<string, unknown>): Record<string, unknown> {
	const raw = (cfg && typeof cfg.fs === 'object' ? cfg.fs : {}) as Record<string, unknown>;
	const root = path.resolve(String(raw.root ?? path.join(process.cwd(), 'sandbox')));
	const maxFileSize = typeof raw.maxFileSize === 'number' ? raw.maxFileSize : 1_000_000;
	const allowWrite = raw.allowWrite === true;

	nodeFs.mkdirSync(root, { recursive: true });

	const ops = {
		read: (p: unknown) => {
			const resolved = resolveJailPath(String(p), root, 'read');
			checkSymlinkSafe(resolved, root, 'read');
			const st = nodeFs.statSync(resolved);
			if (st.size > maxFileSize) throw new RuntimeError(`fs.read: file too large (${st.size} > ${maxFileSize} bytes)`);
			return nodeFs.readFileSync(resolved, 'utf-8');
		},
		exists: (p: unknown) => {
			const resolved = resolveJailPath(String(p), root, 'exists');
			checkSymlinkSafe(resolved, root, 'exists');
			return nodeFs.existsSync(resolved);
		},
		list: (p: unknown) => {
			const resolved = resolveJailPath(String(p), root, 'list');
			checkSymlinkSafe(resolved, root, 'list');
			return nodeFs.readdirSync(resolved);
		},
		isDir: (p: unknown) => {
			const resolved = resolveJailPath(String(p), root, 'isDir');
			checkSymlinkSafe(resolved, root, 'isDir');
			return nodeFs.existsSync(resolved) && nodeFs.statSync(resolved).isDirectory();
		},
		size: (p: unknown) => {
			const resolved = resolveJailPath(String(p), root, 'size');
			checkSymlinkSafe(resolved, root, 'size');
			return nodeFs.statSync(resolved).size;
		},
		write: (p: unknown, content: unknown, overwrite?: unknown) => {
			if (!allowWrite) throw new RuntimeError('fs.write: writes are disabled in config');
			const resolved = resolveJailPath(String(p), root, 'write');
			const text = String(content);
			if (text.length > maxFileSize) throw new RuntimeError(`fs.write: content too large (${text.length} > ${maxFileSize} bytes)`);
			nodeFs.mkdirSync(path.dirname(resolved), { recursive: true });
			checkSymlinkSafe(resolved, root, 'write');
			const flag = overwrite === true ? 'w' : 'wx';
			try {
				// "wx" refuses to clobber an existing file by default; overwrite=true
				// switches to "w" on purpose (models rewriting a config hit this path)
				nodeFs.writeFileSync(resolved, text, { flag });
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
					throw new RuntimeError(`fs.write: file already exists (pass overwrite=true to replace it, or use fs.append): ${String(p)}`);
				}
				throw err;
			}
			return true;
		},
		append: (p: unknown, content: unknown) => {
			if (!allowWrite) throw new RuntimeError('fs.append: writes are disabled in config');
			const resolved = resolveJailPath(String(p), root, 'append');
			const text = String(content);
			if (text.length > maxFileSize) throw new RuntimeError(`fs.append: content too large`);
			checkSymlinkSafe(resolved, root, 'append');
			nodeFs.appendFileSync(resolved, text);
			return true;
		},
		mkdir: (p: unknown) => {
			if (!allowWrite) throw new RuntimeError('fs.mkdir: writes are disabled in config');
			const resolved = resolveJailPath(String(p), root, 'mkdir');
			checkSymlinkSafe(resolved, root, 'mkdir');
			nodeFs.mkdirSync(resolved, { recursive: true });
			return true;
		},
		remove: (p: unknown) => {
			if (!allowWrite) throw new RuntimeError('fs.remove: writes are disabled in config');
			const resolved = resolveJailPath(String(p), root, 'remove');
			checkSymlinkSafe(resolved, root, 'remove');
			const st = nodeFs.lstatSync(resolved);
			if (st.isDirectory()) {
				// only remove if empty: no recursive nukes from a tool script
				if (nodeFs.readdirSync(resolved).length > 0) throw new RuntimeError('fs.remove: directory not empty, use fs.rmtree if you really mean it');
				nodeFs.rmdirSync(resolved);
			} else nodeFs.unlinkSync(resolved);
			return true;
		},
		rmtree: (p: unknown) => {
			if (!allowWrite) throw new RuntimeError('fs.rmtree: writes are disabled in config');
			const resolved = resolveJailPath(String(p), root, 'rmtree');
			checkSymlinkSafe(resolved, root, 'rmtree');
			// belt and braces: refuse to nuke the sandbox root itself
			if (resolved === root) throw new RuntimeError('fs.rmtree: refusing to remove the sandbox root');
			nodeFs.rmSync(resolved, { recursive: true });
			return true;
		}
	};
	return ops;
}
