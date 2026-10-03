// The github addon's repository half: the allow_repo_* gates decide which
// functions even reach the model's schema, and the diff engine that turns a
// unified diff into a real commit is pure (and picky) by design.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { loadConfig, resetConfigCache, AppConfig } from '../utils/config.js';
import { GitHub } from '../../modules/addons/github.js';
import { parseUnifiedDiff, applyDiff } from '../../modules/addons/github_diff.js';

function makeConfig(github: Record<string, unknown>): AppConfig {
	const base = loadConfig('example.config.toml');
	return { ...base, addons: { enabled: ['github'], github } } as AppConfig;
}

function names(): string[] {
	return GitHub.functions.map((f) => f.name);
}

function errorOf(call: () => unknown): string {
	try {
		call();
	} catch (err) {
		return (err as Error).message;
	}
	return '';
}

async function failureOf(call: () => Promise<unknown>): Promise<string> {
	try {
		await call();
	} catch (err) {
		return (err as Error).message;
	}
	return '';
}

describe('allow_repo_* gates', () => {
	beforeEach(() => {
		resetConfigCache();
		delete process.env.GITHUB_TOKEN;
	});
	afterEach(() => resetConfigCache());

	test('both flags off: issues/PRs stay, repository lifecycle is invisible', async () => {
		await GitHub.init!(makeConfig({ token: 'fake-token-123' }));
		const n = names();
		expect(n).toEqual(expect.arrayContaining(['github_create_issue', 'github_list_branches', 'github_list_releases']));
		expect(n).not.toContain('github_create_repo');
		expect(n).not.toContain('github_delete_repo');
		expect(n).not.toContain('github_fork_repo');
		expect(n).not.toContain('github_apply_diff');
		expect(n).not.toContain('github_create_branch');
		expect(n).not.toContain('github_delete_branch');
	});

	test('allow_repo_creation adds create/fork/edit/branch/apply_diff but no deletes', async () => {
		await GitHub.init!(makeConfig({ token: 'fake-token-123', allow_repo_creation: true }));
		const n = names();
		expect(n).toEqual(expect.arrayContaining(['github_create_repo', 'github_fork_repo', 'github_edit_repo', 'github_create_branch', 'github_apply_diff']));
		expect(n).not.toContain('github_delete_repo');
		expect(n).not.toContain('github_delete_branch');
	});

	test('allow_repo_deletion adds the destructive pair', async () => {
		await GitHub.init!(makeConfig({ token: 'fake-token-123', allow_repo_deletion: true }));
		expect(names()).toEqual(expect.arrayContaining(['github_delete_repo', 'github_delete_branch']));
	});

	test('every mutation is flagged dangerous so it gets audit-logged', async () => {
		await GitHub.init!(makeConfig({ token: 'fake-token-123', allow_repo_creation: true, allow_repo_deletion: true }));
		for (const name of ['github_create_repo', 'github_delete_repo', 'github_apply_diff', 'github_create_issue']) {
			expect(GitHub.functions.find((f) => f.name === name)?.dangerous, name).toBe(true);
		}
		expect(GitHub.functions.find((f) => f.name === 'github_repo_info')?.dangerous).toBe(false);
	});

	test('a write without a token fails with instructions, not a stack', async () => {
		await GitHub.init!(makeConfig({ allow_repo_creation: true }));
		const fn = GitHub.functions.find((f) => f.name === 'github_apply_diff')!;
		expect(await failureOf(() => fn.execute({ repo: 'beci/repo', branch: 'main', diff: 'x' }))).toContain('GITHUB_TOKEN');
	});

	test('the allowlist also covers creations and pushes (no bypass by naming a new repo)', async () => {
		await GitHub.init!(makeConfig({ token: 'fake-token-123', allow_repo_creation: true, default_owner: 'beci', allowed_repos: ['beci/only'] }));
		const create = GitHub.functions.find((f) => f.name === 'github_create_repo')!;
		expect(await failureOf(() => create.execute({ name: 'sneaky' }))).toContain('allowed_repos');
		const push = GitHub.functions.find((f) => f.name === 'github_apply_diff')!;
		expect(await failureOf(() => push.execute({ repo: 'other/repo', branch: 'main', diff: 'diff --git a/x b/x' }))).toContain('allowed_repos');
	});

	test('repo names and branches are validated before any request', async () => {
		await GitHub.init!(makeConfig({ token: 'fake-token-123', allow_repo_creation: true }));
		const create = GitHub.functions.find((f) => f.name === 'github_create_repo')!;
		expect(await failureOf(() => create.execute({ name: 'bad name!' }))).toContain('invalid repo name');
		expect(await failureOf(() => create.execute({ name: 'x', org: '../evil' }))).toContain('invalid org');
	});
});

const SAMPLE_DIFF = [
	'diff --git a/src/hello.ts b/src/hello.ts',
	'index 1111111..2222222 100644',
	'--- a/src/hello.ts',
	'+++ b/src/hello.ts',
	'@@ -1,3 +1,4 @@',
	' line one',
	'-line two',
	'+line 2',
	'+line two and a half',
	' line three',
	'',
	'diff --git a/new.txt b/new.txt',
	'new file mode 100644',
	'index 0000000..3333333',
	'--- /dev/null',
	'+++ b/new.txt',
	'@@ -0,0 +1,2 @@',
	'+first',
	'+second'
].join('\n');

describe('unified diff engine', () => {
	test('splits sections, classifies ops and applies hunks', () => {
		const patches = parseUnifiedDiff(SAMPLE_DIFF);
		expect(patches).toHaveLength(2);
		expect(patches[0]).toMatchObject({ path: 'src/hello.ts', op: 'modify' });
		expect(patches[1]).toMatchObject({ path: 'new.txt', op: 'create' });

		const content = applyDiff('line one\nline two\nline three\n', patches[0]);
		expect(content).toBe('line one\nline 2\nline two and a half\nline three\n');
		expect(applyDiff('', patches[1])).toBe('first\nsecond\n');
	});

	test('a removed line that looks like a header cannot derail the parser', () => {
		const diff = ['diff --git a/notes.md b/notes.md', '--- a/notes.md', '+++ b/notes.md', '@@ -1,2 +1 @@', ' intro', '--- not a header, just deleted text'].join('\n');
		const patches = parseUnifiedDiff(diff);
		expect(patches).toHaveLength(1);
		expect(patches[0].op).toBe('modify');
		// the leading '-' is the diff marker: the file really holds "-- not ..."
		expect(applyDiff('intro\n-- not a header, just deleted text\n', patches[0])).toBe('intro\n');
	});

	test('a stale diff is refused instead of mangling the file', () => {
		const patches = parseUnifiedDiff(SAMPLE_DIFF);
		expect(errorOf(() => applyDiff('completely\ndifferent\nfile\n', patches[0]))).toContain('does not match the diff');
		// out-of-range hunk (file is shorter than the hunk claims)
		expect(errorOf(() => applyDiff('one line\n', patches[0]))).toContain('outside');
	});

	test('traversal and junk paths never survive parsing', () => {
		const evil = ['diff --git a/x b/x', '--- /dev/null', '+++ b/../../etc/passwd', '@@ -0,0 +1 @@', '+pwned'].join('\n');
		expect(errorOf(() => parseUnifiedDiff(evil))).toContain('no ..');
		expect(errorOf(() => parseUnifiedDiff(''))).toContain('empty');
		expect(errorOf(() => parseUnifiedDiff('just some text'))).toContain('missing ---/+++');
		expect(errorOf(() => parseUnifiedDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n'))).toContain('no hunks');
	});

	test('hunk line counts that do not add up are rejected', () => {
		const broken = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,5 +1,5 @@', ' only one old line here'].join('\n');
		expect(errorOf(() => parseUnifiedDiff(broken))).toContain('corrupt diff');
		// new-line counts too: a hunk that lost lines on the way in must not
		// silently drop content from the file
		const missingNew = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,1 +1,3 @@', ' line one', '+two'].join('\n');
		expect(errorOf(() => parseUnifiedDiff(missingNew))).toContain('new lines');
	});

	test('pure insertions land AFTER the line git numbered (zero-count hunks)', () => {
		// git writes `@@ -5,0` for "insert after line 5" and `@@ -0,0` for
		// "insert at the top": oldStart is the index, not oldStart - 1
		const after = parseUnifiedDiff(['diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -2,0 +3 @@', '+inserted'].join('\n'));
		expect(applyDiff('one\ntwo\nthree\nfour\nfive\n', after[0])).toBe('one\ntwo\ninserted\nthree\nfour\nfive\n');

		const top = parseUnifiedDiff(['diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -0,0 +1 @@', '+first'].join('\n'));
		expect(applyDiff('one\ntwo\n', top[0])).toBe('first\none\ntwo\n');

		// an existing but EMPTY file: -0,0 must still work (the file has 0 lines)
		const fill = parseUnifiedDiff(['diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -0,0 +1,2 @@', '+a', '+b'].join('\n'));
		expect(applyDiff('', fill[0])).toBe('a\nb\n');

		// an insertion point past the end of the file is refused loudly
		const outside = parseUnifiedDiff(['diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -99,0 +100 @@', '+nope'].join('\n'));
		expect(errorOf(() => applyDiff('one\ntwo\n', outside[0]))).toContain('outside');
	});

	test('size caps hold', () => {
		expect(errorOf(() => parseUnifiedDiff('x'.repeat(300_001)))).toContain('larger than');
		const one = ['diff --git a/f0 b/f0', '--- /dev/null', '+++ b/f0', '@@ -0,0 +1 @@', '+a'].join('\n');
		const many = Array.from({ length: 21 }, (_, i) => one.replace(/f0/g, `f${i}`)).join('\n');
		expect(errorOf(() => parseUnifiedDiff(many))).toContain('more than 20 files');
	});
});
