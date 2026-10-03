/// Addon: github (client half)
/// Everything that talks to api.github.com lives here: config parsing,
/// path/host validation, auth and the request wrapper. The agent-facing
/// function list is split out (github.ts, github_repos.ts) so no file grows
/// past the point where nobody reads it.
///
/// Token rules: it comes from GITHUB_TOKEN env or addons.github.token, it is
/// only ever attached as an Authorization header (never logged, never echoed
/// back, never in an error), and write calls fail with a clear message when
/// it is missing.

import { isHostAllowed } from '../../src/utils/toolang/netguard.js';
import { AppConfig } from '../../src/utils/config.js';
import { AgentFunction } from '../../src/modules/types.js';
import { parseUnifiedDiff, applyDiff } from './github_diff.js';

const API_HOST = 'api.github.com';
const TIMEOUT_MS = 15_000;

export interface GitHubConfig {
	token?: string;
	/** default owner/org so short names like "repo" resolve against it */
	default_owner?: string;
	/** optional allowlist of "owner/repo" the agent may touch; empty = all */
	allowed_repos?: string[];
	/** allow_repo_creation: create/fork repos, edit metadata, create branches */
	allow_repo_creation: boolean;
	/** allow_repo_deletion: delete repos + branches (needs delete_repo scope) */
	allow_repo_deletion: boolean;
}

function bool(raw: Record<string, unknown>, key: string): boolean {
	return raw[key] === true;
}

const UNEXPANDED_ENV_RE = /^\$\{[A-Z0-9_]+\}$/;

export function getConfig(config: AppConfig): GitHubConfig {
	const raw = (config.addons as unknown as Record<string, Record<string, unknown>>).github ?? {};
	// an unexpanded ${VAR} reference means the env var was never set: treating
	// it as a token would send "Authorization: Bearer ${GITHUB_TOKEN}" to GitHub
	let token = typeof raw.token === 'string' ? raw.token.trim() : '';
	if (UNEXPANDED_ENV_RE.test(token)) token = '';
	let allowed: string[] | undefined;
	if (Array.isArray(raw.allowed_repos)) {
		allowed = raw.allowed_repos
			.map(String)
			.map((s) => s.trim())
			.filter(Boolean);
		// fail closed AND loud: a junk entry must not silently widen the allowlist
		const bad = allowed.find((e) => !FULL_REPO_RE.test(e));
		if (bad) throw new Error(`github: addons.github.allowed_repos entry '${bad.slice(0, 60)}' is not an owner/repo pair`);
		allowed = allowed.slice(0, 100);
	}
	return {
		token: token.length > 0 ? token : undefined,
		default_owner: typeof raw.default_owner === 'string' && raw.default_owner.trim() ? raw.default_owner.trim() : undefined,
		allowed_repos: allowed,
		allow_repo_creation: bool(raw, 'allow_repo_creation'),
		allow_repo_deletion: bool(raw, 'allow_repo_deletion')
	};
}

/** HTTP error that keeps the status code (404 = "file/repo does not exist"). */
export class GitHubHttpError extends Error {
	constructor(
		public readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'GitHubHttpError';
	}
}

/** owner or repo segment: no slashes, no dots-only names, bounded */
const SEGMENT_RE = /^[a-zA-Z0-9_.-]{1,100}$/;
export const FULL_REPO_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
/** git branch/ref names: printable, no traversal, no lock suffix, no @{ */
const BRANCH_RE = /^(?!.*\.\.)(?!.*@\{)(?!\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._\-/]{1,100}$/;

export function checkSegment(value: unknown, what: string): string {
	const s = String(value ?? '').trim();
	if (!SEGMENT_RE.test(s) || s === '.' || s === '..') throw new Error(`github: invalid ${what} '${s.slice(0, 40)}'`);
	return s;
}

export function checkBranch(value: unknown): string {
	const s = String(value ?? '').trim();
	if (!BRANCH_RE.test(s)) throw new Error(`github: invalid branch name '${s.slice(0, 40)}'`);
	return s;
}

/** Small builder shared by the github function lists (github.ts / github_repos.ts). */
export function fn(name: string, description: string, parameters: Record<string, unknown>, execute: (args: Record<string, unknown>) => Promise<unknown>, dangerous = false): AgentFunction {
	return { name, description, parameters, execute, dangerous };
}

export class GitHubClient {
	constructor(
		private cfg: GitHubConfig,
		private token: string | undefined
	) {}

	private async request(method: string, path: string, body?: unknown): Promise<unknown> {
		const clean = ('/' + path).replace(/\/+/g, '/');
		if (!/^\/[a-zA-Z0-9._\-/?=&%:]+$/.test(clean)) throw new Error('github: invalid path');
		// no `..` can ever reach the URL (every segment is validated upstream,
		// this is the last line of defense against path traversal)
		if (clean.split('/').some((seg) => seg === '..')) throw new Error('github: invalid path');
		const url = new URL(`https://${API_HOST}${clean}`);
		if (!isHostAllowed(url.hostname, { blockPrivate: true })) throw new Error('github: host blocked by policy');
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
		try {
			const resp = await fetch(url, {
				method,
				headers: {
					'Accept': 'application/vnd.github+json',
					'User-Agent': 'discord-ai-agent',
					'X-GitHub-Api-Version': '2022-11-28',
					...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
					...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: controller.signal,
				redirect: 'error'
			});
			if (resp.status === 403 && resp.headers.get('x-ratelimit-remaining') === '0') {
				throw new Error('github: rate limited');
			}
			if (!resp.ok) {
				const text = await resp.text();
				// surface GitHub's message but never the auth header/token
				let msg = `HTTP ${resp.status}`;
				try {
					const parsed = JSON.parse(text) as { message?: string };
					if (parsed.message) msg = parsed.message;
				} catch {
					/* keep status */
				}
				throw new GitHubHttpError(resp.status, `github: ${msg}`);
			}
			const text = await resp.text();
			if (text.length === 0) return {};
			return JSON.parse(text);
		} finally {
			clearTimeout(timer);
		}
	}

	/** case-insensitive: GitHub itself never tells owner/Repo from Owner/repo */
	private allowlisted(full: string): boolean {
		const list = this.cfg.allowed_repos ?? [];
		return list.some((e) => e.toLowerCase() === full.toLowerCase());
	}

	repo(full: unknown): string {
		const name = String(full ?? '').trim();
		let resolved: string;
		if (FULL_REPO_RE.test(name)) resolved = name;
		else if (this.cfg.default_owner && SEGMENT_RE.test(name)) resolved = `${this.cfg.default_owner}/${name}`;
		else throw new Error("github: pass 'owner/repo' (or set addons.github.default_owner)");
		if (this.cfg.allowed_repos && this.cfg.allowed_repos.length > 0 && !this.allowlisted(resolved)) {
			throw new Error(`github: repo '${resolved}' is not in addons.github.allowed_repos`);
		}
		return resolved;
	}

	/**
	 * Where a NEW repository would land, so the allowlist can be applied to
	 * creations too (otherwise allowlist + create = bypass).
	 */
	repoForCreate(name: unknown, org?: unknown): string {
		const owner = org !== undefined && String(org ?? '').trim() ? checkSegment(org, 'org') : this.cfg.default_owner;
		const repoName = checkSegment(name, 'repo name');
		if (!owner) {
			if (this.cfg.allowed_repos && this.cfg.allowed_repos.length > 0) {
				throw new Error("github: set addons.github.default_owner (or pass 'org') so the new repo can be checked against allowed_repos");
			}
			return `me/${repoName}`;
		}
		const full = `${owner}/${repoName}`;
		if (this.cfg.allowed_repos && this.cfg.allowed_repos.length > 0 && !this.allowlisted(full)) {
			throw new Error(`github: repo '${full}' is not in addons.github.allowed_repos`);
		}
		return full;
	}

	requireToken(op: string): string {
		if (!this.token) throw new Error(`github.${op} needs a token: set GITHUB_TOKEN env or addons.github.token`);
		return this.token;
	}

	hasToken(): boolean {
		return Boolean(this.token);
	}

	private loginCache: string | null = null;

	/** The authenticated login (cached): tells a personal account from an org. */
	private async login(): Promise<string> {
		if (this.loginCache !== null) return this.loginCache;
		const me = (await this.request('GET', 'user')) as { login?: string };
		this.loginCache = String(me?.login ?? '');
		return this.loginCache;
	}

	// ---------------- read ----------------

	async repoInfo(full: unknown): Promise<unknown> {
		return this.request('GET', `repos/${this.repo(full)}`);
	}
	async listIssues(full: unknown, state: unknown): Promise<unknown> {
		const s = state === undefined ? 'open' : String(state);
		if (!['open', 'closed', 'all'].includes(s)) throw new Error('state must be open|closed|all');
		return this.request('GET', `repos/${this.repo(full)}/issues?state=${s}&per_page=20`);
	}
	async listPulls(full: unknown, state: unknown): Promise<unknown> {
		const s = state === undefined ? 'open' : String(state);
		if (!['open', 'closed', 'all'].includes(s)) throw new Error('state must be open|closed|all');
		return this.request('GET', `repos/${this.repo(full)}/pulls?state=${s}&per_page=20`);
	}
	async listRepos(): Promise<unknown> {
		this.requireToken('list_repos');
		return this.request('GET', 'user/repos?per_page=30&sort=updated');
	}
	async listBranches(full: unknown): Promise<unknown> {
		return this.request('GET', `repos/${this.repo(full)}/branches?per_page=30`);
	}
	async listReleases(full: unknown): Promise<unknown> {
		return this.request('GET', `repos/${this.repo(full)}/releases?per_page=10`);
	}

	// ---------------- issues / prs (always available once the addon is on) ----------------

	async createIssue(full: unknown, title: unknown, body: unknown): Promise<unknown> {
		this.requireToken('create_issue');
		const t = String(title ?? '').trim();
		if (t.length === 0 || t.length > 256) throw new Error('title must be 1-256 chars');
		const b = String(body ?? '').slice(0, 64_000);
		return this.request('POST', `repos/${this.repo(full)}/issues`, { title: t, body: b });
	}
	async commentIssue(full: unknown, number: unknown, body: unknown): Promise<unknown> {
		this.requireToken('comment_issue');
		const n = Number(number);
		if (!Number.isInteger(n) || n < 1) throw new Error('invalid issue number');
		const b = String(body ?? '').trim();
		if (b.length === 0 || b.length > 64_000) throw new Error('comment body must be 1-64000 chars');
		return this.request('POST', `repos/${this.repo(full)}/issues/${n}/comments`, { body: b });
	}
	async closeIssue(full: unknown, number: unknown, reopen: boolean): Promise<unknown> {
		this.requireToken(reopen ? 'reopen_issue' : 'close_issue');
		const n = Number(number);
		if (!Number.isInteger(n) || n < 1) throw new Error('invalid issue number');
		return this.request('PATCH', `repos/${this.repo(full)}/issues/${n}`, { state: reopen ? 'open' : 'closed' });
	}
	async mergePull(full: unknown, number: unknown, method: unknown): Promise<unknown> {
		this.requireToken('merge_pull');
		const n = Number(number);
		if (!Number.isInteger(n) || n < 1) throw new Error('invalid PR number');
		const m = method === undefined ? 'merge' : String(method);
		if (!['merge', 'squash', 'rebase'].includes(m)) throw new Error('merge method must be merge|squash|rebase');
		return this.request('POST', `repos/${this.repo(full)}/pulls/${n}/merge`, { merge_method: m });
	}
	async commentPull(full: unknown, number: unknown, body: unknown): Promise<unknown> {
		// PR review comments go through the issues API for plain comments
		return this.commentIssue(full, number, body);
	}
	async starRepo(full: unknown): Promise<unknown> {
		this.requireToken('star_repo');
		const repo = this.repo(full);
		return this.request('PUT', `user/starred/${repo}`);
	}

	// ---------------- repository lifecycle (flag-gated in github_repos.ts) ----------------

	async createRepo(name: unknown, org: unknown, description: unknown, isPrivate: unknown, autoInit: unknown): Promise<unknown> {
		this.requireToken('create_repo');
		// resolves against default_owner and runs the allowlist check
		const full = this.repoForCreate(name, org);
		const body: Record<string, unknown> = {
			name: checkSegment(name, 'repo name'),
			// private by default: a public repo by accident is not undoable
			private: isPrivate !== false,
			auto_init: autoInit !== false
		};
		const desc = String(description ?? '').trim();
		if (desc) body.description = desc.slice(0, 350); // API limit
		const explicitOrg = org !== undefined && String(org ?? '').trim() ? checkSegment(org, 'org') : undefined;
		// default_owner only becomes an org target when it is NOT the signed-in
		// user (there is no POST /users/{login}/repos, that always 404s)
		const owner = full.split('/')[0];
		let asOrg = explicitOrg;
		if (!asOrg && this.cfg.default_owner && owner === this.cfg.default_owner) {
			asOrg = (await this.login()) === owner ? undefined : owner;
		}
		if (asOrg) return this.request('POST', `orgs/${asOrg}/repos`, body);
		return this.request('POST', 'user/repos', body);
	}

	async deleteRepo(full: unknown): Promise<unknown> {
		this.requireToken('delete_repo');
		const repo = this.repo(full);
		return this.request('DELETE', `repos/${repo}`);
	}

	async forkRepo(full: unknown, org: unknown): Promise<unknown> {
		this.requireToken('fork_repo');
		const source = this.repo(full); // allowlist-checked like every other call
		const name = source.split('/')[1];
		// the copy lands in the operator's account: check its future name too
		this.repoForCreate(name, org);
		const explicitOrg = org !== undefined && String(org ?? '').trim() ? checkSegment(org, 'org') : undefined;
		let target = explicitOrg;
		if (!target && this.cfg.default_owner) target = (await this.login()) === this.cfg.default_owner ? undefined : this.cfg.default_owner;
		const body = target ? { organization: target } : undefined;
		return this.request('POST', `repos/${source}/forks`, body);
	}

	async editRepo(full: unknown, patch: { description?: unknown; homepage?: unknown; isPrivate?: unknown }): Promise<unknown> {
		this.requireToken('edit_repo');
		const repo = this.repo(full);
		const body: Record<string, unknown> = {};
		if (patch.description !== undefined) {
			const d = String(patch.description).trim().slice(0, 350);
			body.description = d;
		}
		if (patch.homepage !== undefined) {
			const h = String(patch.homepage).trim().slice(0, 255);
			if (h && !/^https?:\/\/\S+$/.test(h)) throw new Error('homepage must be an http(s) URL');
			body.homepage = h;
		}
		if (patch.isPrivate !== undefined) body.private = patch.isPrivate === true;
		if (Object.keys(body).length === 0) throw new Error('edit_repo: send at least one of description, homepage, private');
		return this.request('PATCH', `repos/${repo}`, body);
	}

	async createBranch(full: unknown, branch: unknown, from: unknown): Promise<unknown> {
		this.requireToken('create_branch');
		const repo = this.repo(full);
		const newBranch = checkBranch(branch);
		const body: Record<string, unknown> = { new_branch: newBranch };
		if (from !== undefined && String(from ?? '').trim()) body.from_branch = checkBranch(from);
		return this.request('POST', `repos/${repo}/branches`, body);
	}

	async deleteBranch(full: unknown, branch: unknown): Promise<unknown> {
		this.requireToken('delete_branch');
		const repo = this.repo(full);
		const b = checkBranch(branch);
		if (b === 'main' || b === 'master') throw new Error(`github: refusing to delete the default branch '${b}'`);
		// the default branch can be anything (develop, trunk, ...): losing it
		// breaks every open PR, so ask the repo before deleting
		const info = (await this.request('GET', `repos/${repo}`)) as { default_branch?: unknown };
		const def = String(info?.default_branch ?? '');
		if (def && b.toLowerCase() === def.toLowerCase()) {
			throw new Error(`github: '${b}' is the default branch of '${repo}', refusing to delete it`);
		}
		return this.request('DELETE', `repos/${repo}/branches/${encodeURIComponent(b)}`);
	}

	// ---------------- one commit from a unified diff ----------------

	/** Same as request(), but a 404 answers null (used for file reads). */
	private async requestAllow404(method: string, path: string): Promise<unknown | null> {
		try {
			return await this.request(method, path);
		} catch (err) {
			// matched on the STATUS, not on GitHub's message text: a localized or
			// HTML 404 page used to turn "file does not exist" into a hard error
			if (err instanceof GitHubHttpError && err.status === 404) return null;
			throw err;
		}
	}

	/** Current content of a file on a branch, or null when it does not exist. */
	private async fileAt(repo: string, filePath: string, ref: string): Promise<string | null> {
		const data = (await this.requestAllow404('GET', `repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`)) as {
			content?: string;
			encoding?: string;
			size?: number;
		} | null;
		if (!data) return null;
		if (data.encoding !== 'base64' || typeof data.content !== 'string') {
			throw new Error(`github: '${filePath}' is too large for the contents API, split the change`);
		}
		// the contents API answers files >1MB with EMPTY content: without this
		// check a big file looked like a blank one and the diff would "match"
		if (data.content.length === 0 && Number(data.size ?? 0) > 0) {
			throw new Error(`github: '${filePath}' is too large for the contents API, split the change`);
		}
		return Buffer.from(data.content, 'base64').toString('utf-8');
	}

	/**
	 * Push a commit built from a unified diff: read head, apply every hunk to
	 * the real file contents (github_diff.ts refuses stale hunks), upload
	 * blobs, build one tree/commit and fast-forward the branch. No git binary,
	 * one commit, all-or-nothing (the ref only moves at the very end).
	 */
	async applyDiff(full: unknown, branch: unknown, diff: unknown, message: unknown): Promise<unknown> {
		this.requireToken('apply_diff');
		const repo = this.repo(full);
		const ref = checkBranch(branch);
		const patches = parseUnifiedDiff(diff);
		const msg =
			String(message ?? '')
				.trim()
				.slice(0, 200) || `Apply ${patches.length} file change(s)`;

		const refInfo = (await this.request('GET', `repos/${repo}/git/ref/heads/${encodeURIComponent(ref)}`)) as { object?: { sha?: string } };
		const head = String(refInfo?.object?.sha ?? '');
		if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error(`github: could not read the head commit of '${ref}'`);
		const headCommit = (await this.request('GET', `repos/${repo}/git/commits/${head}`)) as { tree?: { sha?: string } };
		const baseTree = String(headCommit?.tree?.sha ?? '');
		if (!baseTree) throw new Error('github: could not read the head tree');

		const entries: Record<string, unknown>[] = [];
		const summary: string[] = [];
		for (const patch of patches) {
			if (patch.op === 'delete') {
				entries.push({ path: patch.path, mode: '100644', type: 'blob', sha: null });
				summary.push(`delete ${patch.path}`);
				continue;
			}
			const current = patch.op === 'modify' ? await this.fileAt(repo, patch.path, ref) : null;
			if (patch.op === 'modify' && current === null) throw new Error(`github: '${patch.path}' does not exist on '${ref}' but the diff modifies it`);
			if (patch.op === 'create' && current !== null) throw new Error(`github: '${patch.path}' already exists but the diff says it is new`);
			const next = applyDiff(current ?? '', patch);
			if (Buffer.byteLength(next, 'utf-8') > 1_000_000) throw new Error(`github: '${patch.path}' would exceed 1MB after the diff`);
			const blob = (await this.request('POST', `repos/${repo}/git/blobs`, { content: next, encoding: 'utf-8' })) as { sha?: string };
			if (!blob?.sha) throw new Error('github: blob upload failed');
			entries.push({ path: patch.path, mode: '100644', type: 'blob', sha: blob.sha });
			summary.push(`${patch.op} ${patch.path}`);
		}

		const tree = (await this.request('POST', `repos/${repo}/git/trees`, { base_tree: baseTree, tree: entries })) as { sha?: string };
		if (!tree?.sha) throw new Error('github: tree creation failed');
		const commit = (await this.request('POST', `repos/${repo}/git/commits`, { message: msg, parents: [head], tree: tree.sha })) as { sha?: string };
		if (!commit?.sha) throw new Error('github: commit creation failed');
		// the branch only moves once the commit exists: no half-pushed state
		await this.request('PATCH', `repos/${repo}/git/refs/heads/${encodeURIComponent(ref)}`, { sha: commit.sha });
		return { sha: commit.sha, branch: ref, message: msg, files: summary };
	}
}
