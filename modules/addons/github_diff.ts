/// Addon: github (diff half)
/// Pure helpers that turn a unified diff into concrete file contents, so the
/// agent can push a real commit without a git binary on the box:
/// parse the diff, apply each hunk to the CURRENT content of the file on the
/// branch (and refuse when it does not line up), then github_client.ts commits
/// the result through the Git Data API as one commit.
///
/// Everything here is pure and unit-tested: no network, no fs, no git.

/** One `@@ -a,b +c,d @@` block. */
export interface Hunk {
	oldStart: number;
	oldCount: number;
	/** `+count` from the header (defaults to 1, like the format spec says) */
	newCount: number;
	oldLines: string[];
	newLines: string[];
}

export type FileOp = 'create' | 'modify' | 'delete';

export interface FilePatch {
	path: string;
	op: FileOp;
	hunks: Hunk[];
}

const MAX_DIFF_CHARS = 300_000;
const MAX_FILES = 20;
const MAX_PATH = 1_000;
/** no traversal, no absolute paths, no quotes/backspaces: plain repo paths */
const PATH_RE = /^[A-Za-z0-9._\-/]+$/;

function badPath(what: string): never {
	throw new Error(`github: invalid path in diff (${what})`);
}

/** `a/src/x.ts`, `b/src/x.ts`, `"a/sp ace.ts"` or `/dev/null` -> path or null */
function parseHeaderPath(raw: string): string | null {
	let p = raw.trim();
	if (p === '/dev/null' || p === '') return null;
	// git quotes paths it considers unsafe; we accept the simple unquoted form
	if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
	if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
	if (p.length === 0 || p.length > MAX_PATH || !PATH_RE.test(p)) badPath('unsupported characters');
	if (p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) badPath('no .. or empty segments');
	return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Split a unified diff into per-file patches.
 * Sections are split on `diff --git` first, so a removed line that happens to
 * look like a header (`--- foo`) can never be mistaken for one.
 */
export function parseUnifiedDiff(raw: unknown): FilePatch[] {
	const diff = typeof raw === 'string' ? raw : '';
	if (diff.trim().length === 0) throw new Error('github: the diff is empty');
	if (diff.length > MAX_DIFF_CHARS) throw new Error(`github: diff is larger than ${MAX_DIFF_CHARS} chars`);

	const lines = diff.replace(/\r\n/g, '\n').split('\n');
	const sections: string[][] = [[]];
	for (const line of lines) {
		if (line.startsWith('diff --git ')) {
			sections.push([]);
			continue;
		}
		sections[sections.length - 1].push(line);
	}

	const files: FilePatch[] = [];
	for (const section of sections) {
		if (section.every((l) => l.trim().length === 0)) continue;
		files.push(parseSection(section));
		if (files.length > MAX_FILES) throw new Error(`github: the diff touches more than ${MAX_FILES} files`);
	}
	if (files.length === 0) throw new Error('github: the diff changes no file (expected ---/+++ headers)');
	return files;
}

function parseSection(section: string[]): FilePatch {
	// --- / +++ headers sit near the top (after new file mode / index lines)
	const minusIdx = section.findIndex((l) => l.startsWith('--- '));
	const plusIdx = section.findIndex((l) => l.startsWith('+++ '));
	if (minusIdx === -1 || plusIdx === -1 || plusIdx < minusIdx) {
		throw new Error('github: diff section is missing ---/+++ file headers');
	}
	const oldPath = parseHeaderPath(section[minusIdx].slice(4));
	const newPath = parseHeaderPath(section[plusIdx].slice(4));

	let op: FileOp;
	let path: string;
	if (newPath === null && oldPath !== null) {
		op = 'delete';
		path = oldPath;
	} else if (oldPath === null && newPath !== null) {
		op = 'create';
		path = newPath;
	} else if (oldPath !== null && newPath !== null) {
		op = 'modify';
		path = newPath;
	} else {
		throw new Error('github: diff section deletes nothing and creates nothing');
	}

	// hunks
	const hunks: Hunk[] = [];
	let hunk: Hunk | null = null;
	for (let i = plusIdx + 1; i < section.length; i++) {
		const line = section[i];
		const m = HUNK_RE.exec(line);
		if (m) {
			hunk = {
				oldStart: Number(m[1]),
				oldCount: m[2] === undefined ? 1 : Number(m[2]),
				newCount: m[4] === undefined ? 1 : Number(m[4]),
				oldLines: [],
				newLines: []
			};
			hunks.push(hunk);
			continue;
		}
		if (!hunk) {
			// trailing metadata (index, mode) after the last hunk: ignore
			continue;
		}
		if (line.startsWith('\\ ')) continue; // "\ No newline at end of file"
		const tag = line.charAt(0);
		const text = line.slice(1);
		if (tag === '+') hunk.newLines.push(text);
		else if (tag === '-') hunk.oldLines.push(text);
		else if (tag === ' ') {
			hunk.oldLines.push(text);
			hunk.newLines.push(text);
		} else if (line === '') {
			// a truly empty line is context only while the counts are unfinished:
			// after that it is the blank line most tools put between sections
			if (hunk.oldLines.length < hunk.oldCount) {
				hunk.oldLines.push('');
				hunk.newLines.push('');
			} else {
				hunk = null;
			}
		} else {
			// unknown line ends this hunk (metadata like "index ..." post-hunk)
			hunk = null;
		}
	}
	for (const h of hunks) {
		if (h.oldLines.length !== h.oldCount) {
			throw new Error(`github: corrupt diff in '${path}' (hunk at line ${h.oldStart} claims ${h.oldCount} old lines, has ${h.oldLines.length})`);
		}
		// a hunk that lost lines on the way in (bad paste, cut-off message)
		// would otherwise silently drop content
		if (h.newLines.length !== h.newCount) {
			throw new Error(`github: corrupt diff in '${path}' (hunk at line ${h.oldStart} claims ${h.newCount} new lines, has ${h.newLines.length})`);
		}
	}
	if (op !== 'delete' && hunks.length === 0) throw new Error(`github: '${path}' has no hunks`);
	return { path, op, hunks };
}

/**
 * Apply a parsed diff to the CURRENT content of a file.
 * Every old line is verified against the file first: a stale or misdirected
 * diff is refused loudly instead of silently mangling the file.
 * Returns null when the file should not exist (create/delete handled by caller).
 */
export function applyDiff(content: string, patch: FilePatch): string {
	if (patch.op === 'create') {
		const out: string[] = [];
		for (const h of patch.hunks) out.push(...h.newLines);
		return out.join('\n') + '\n';
	}
	if (patch.op === 'delete') return content;

	// split into real lines (a trailing newline is not a line of its own)
	const endsWithNewline = content.length === 0 || content.endsWith('\n');
	const lines = content.split('\n');
	if (endsWithNewline && lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

	// bottom-up, so applying one hunk cannot shift the next one's offsets
	const ordered = [...patch.hunks].sort((a, b) => b.oldStart - a.oldStart);
	for (const h of ordered) {
		// zero-count hunk = pure insertion. git writes `@@ -5,0` for "insert
		// after line 5" and `@@ -0,0` for "insert at the top", so oldStart is
		// the INDEX to insert at (not oldStart - 1 like a real old line)
		if (h.oldCount === 0) {
			if (h.oldStart > lines.length) {
				throw new Error(`github: insertion at line ${h.oldStart} is outside '${patch.path}' (${lines.length} lines): the diff does not match the file on this branch`);
			}
			lines.splice(h.oldStart, 0, ...h.newLines);
			continue;
		}
		const start = h.oldStart - 1;
		if (start < 0 || start + h.oldLines.length > lines.length) {
			throw new Error(`github: hunk at line ${h.oldStart} is outside '${patch.path}' (${lines.length} lines): the diff does not match the file on this branch`);
		}
		for (let i = 0; i < h.oldLines.length; i++) {
			if (lines[start + i] !== h.oldLines[i]) {
				const at = start + i + 1;
				throw new Error(
					`github: '${patch.path}' line ${at} does not match the diff (expected "${h.oldLines[i].slice(0, 60)}", file has "${String(lines[start + i]).slice(0, 60)}"): stale diff, re-read the file first`
				);
			}
		}
		lines.splice(start, h.oldLines.length, ...h.newLines);
	}
	return lines.join('\n') + (endsWithNewline && lines.length > 0 ? '\n' : '');
}
