/// Addon: github
/// Gives the AGENT real GitHub account control as LLM-callable functions:
/// create/close/reopen/comment on issues, comment on PRs, merge PRs, star
/// repos, read issues/PRs/releases. Token from GITHUB_TOKEN env (required for
/// anything that writes). Mutating functions are flagged dangerous so the bot
/// can audit them. The token never lands in logs or responses.

import { isHostAllowed } from "../../src/utils/toolang/netguard.js";
import { AppConfig } from "../../src/utils/config.js";
import { Addon, AgentFunction } from "../../src/modules/types.js";

const API_HOST = "api.github.com";
const TIMEOUT_MS = 15_000;

export interface GitHubConfig {
	token?: string;
	/** default owner/org so short names like "repo" resolve against it */
	default_owner?: string;
	/** optional allowlist of "owner/repo" the agent may touch; empty = all */
	allowed_repos?: string[];
}

function getConfig(config: AppConfig): GitHubConfig {
	const raw = (config.addons as unknown as Record<string, Record<string, unknown>>).github ?? {};
	return {
		token: typeof raw.token === "string" && raw.token.length > 0 ? raw.token : undefined,
		default_owner: typeof raw.default_owner === "string" ? raw.default_owner : undefined,
		allowed_repos: Array.isArray(raw.allowed_repos) ? raw.allowed_repos.map(String) : undefined,
	};
}

class GitHubClient {
	constructor(private cfg: GitHubConfig, private token: string | undefined) {}

	private async request(method: string, path: string, body?: unknown): Promise<unknown> {
		const clean = ("/" + path).replace(/\/+/g, "/");
		if (!/^\/[a-zA-Z0-9._\-/?=&%:]+$/.test(clean)) throw new Error("github: invalid path");
		const url = new URL(`https://${API_HOST}${clean}`);
		if (!isHostAllowed(url.hostname, { blockPrivate: true })) throw new Error("github: host blocked by policy");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
		try {
			const resp = await fetch(url, {
				method,
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": "discord-ai-agent",
					"X-GitHub-Api-Version": "2022-11-28",
					...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
					...(body !== undefined ? { "Content-Type": "application/json" } : {}),
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: controller.signal,
				redirect: "error",
			});
			if (resp.status === 403 && resp.headers.get("x-ratelimit-remaining") === "0") {
				throw new Error("github: rate limited");
			}
			if (!resp.ok) {
				const text = await resp.text();
				// surface GitHub's message but never the auth header/token
				let msg = `HTTP ${resp.status}`;
				try {
					const parsed = JSON.parse(text) as { message?: string };
					if (parsed.message) msg = parsed.message;
				} catch { /* keep status */ }
				throw new Error(`github: ${msg}`);
			}
			const text = await resp.text();
			if (text.length === 0) return {};
			return JSON.parse(text);
		} finally {
			clearTimeout(timer);
		}
	}

	private repo(full: unknown): string {
		const name = String(full ?? "").trim();
		let resolved: string;
		if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(name)) resolved = name;
		else if (this.cfg.default_owner && /^[a-zA-Z0-9_.-]+$/.test(name)) resolved = `${this.cfg.default_owner}/${name}`;
		else throw new Error("github: pass 'owner/repo' (or set addons.github.default_owner)");
		if (this.cfg.allowed_repos && this.cfg.allowed_repos.length > 0 && !this.cfg.allowed_repos.includes(resolved)) {
			throw new Error(`github: repo '${resolved}' is not in addons.github.allowed_repos`);
		}
		return resolved;
	}

	private requireToken(op: string): string {
		if (!this.token) throw new Error(`github.${op} needs a token: set GITHUB_TOKEN env or addons.github.token`);
		return this.token;
	}

	async repoInfo(full: unknown): Promise<unknown> {
		return this.request("GET", `repos/${this.repo(full)}`);
	}
	async listIssues(full: unknown, state: unknown): Promise<unknown> {
		const s = state === undefined ? "open" : String(state);
		if (!["open", "closed", "all"].includes(s)) throw new Error("state must be open|closed|all");
		return this.request("GET", `repos/${this.repo(full)}/issues?state=${s}&per_page=20`);
	}
	async createIssue(full: unknown, title: unknown, body: unknown): Promise<unknown> {
		this.requireToken("create_issue");
		const t = String(title ?? "").trim();
		if (t.length === 0 || t.length > 256) throw new Error("title must be 1-256 chars");
		const b = String(body ?? "").slice(0, 64_000);
		return this.request("POST", `repos/${this.repo(full)}/issues`, { title: t, body: b });
	}
	async commentIssue(full: unknown, number: unknown, body: unknown): Promise<unknown> {
		this.requireToken("comment_issue");
		const n = Number(number);
		if (!Number.isInteger(n) || n < 1) throw new Error("invalid issue number");
		const b = String(body ?? "").trim();
		if (b.length === 0 || b.length > 64_000) throw new Error("comment body must be 1-64000 chars");
		return this.request("POST", `repos/${this.repo(full)}/issues/${n}/comments`, { body: b });
	}
	async closeIssue(full: unknown, number: unknown, reopen: boolean): Promise<unknown> {
		this.requireToken(reopen ? "reopen_issue" : "close_issue");
		const n = Number(number);
		if (!Number.isInteger(n) || n < 1) throw new Error("invalid issue number");
		return this.request("PATCH", `repos/${this.repo(full)}/issues/${n}`, { state: reopen ? "open" : "closed" });
	}
	async listPulls(full: unknown, state: unknown): Promise<unknown> {
		const s = state === undefined ? "open" : String(state);
		if (!["open", "closed", "all"].includes(s)) throw new Error("state must be open|closed|all");
		return this.request("GET", `repos/${this.repo(full)}/pulls?state=${s}&per_page=20`);
	}
	async mergePull(full: unknown, number: unknown, method: unknown): Promise<unknown> {
		this.requireToken("merge_pull");
		const n = Number(number);
		if (!Number.isInteger(n) || n < 1) throw new Error("invalid PR number");
		const m = method === undefined ? "merge" : String(method);
		if (!["merge", "squash", "rebase"].includes(m)) throw new Error("merge method must be merge|squash|rebase");
		return this.request("POST", `repos/${this.repo(full)}/pulls/${n}/merge`, { merge_method: m });
	}
	async commentPull(full: unknown, number: unknown, body: unknown): Promise<unknown> {
		// PR review comments go through the issues API for plain comments
		return this.commentIssue(full, number, body);
	}
	async starRepo(full: unknown): Promise<unknown> {
		this.requireToken("star_repo");
		const repo = this.repo(full);
		return this.request("PUT", `user/starred/${repo}`);
	}
	async listRepos(): Promise<unknown> {
		this.requireToken("list_repos");
		return this.request("GET", "user/repos?per_page=30&sort=updated");
	}
}

function fn(
	name: string,
	description: string,
	parameters: Record<string, unknown>,
	execute: (args: Record<string, unknown>) => Promise<unknown>,
	dangerous = false,
): AgentFunction {
	return { name, description, parameters, execute, dangerous };
}

const repoProp = { type: "string", description: "Repository as 'owner/repo'" };

export const GitHub: Addon = {
	name: "github",
	description: "GitHub account control for the agent: issues, PRs, comments, stars, repo browsing",
	functions: [], // built in init() (needs config)
	init: (config: AppConfig) => {
		const cfg = getConfig(config);
		const token = process.env.GITHUB_TOKEN || cfg.token;
		const c = new GitHubClient(cfg, token);

		GitHub.functions = [
			fn("github_repo_info", "Get metadata (stars, language, description) for a GitHub repository.", { type: "object", properties: { repo: repoProp }, required: ["repo"] }, (a) => c.repoInfo(a.repo)),
			fn("github_list_issues", "List issues (open/closed/all) of a GitHub repository.", { type: "object", properties: { repo: repoProp, state: { type: "string", enum: ["open", "closed", "all"] } }, required: ["repo"] }, (a) => c.listIssues(a.repo, a.state)),
			fn("github_create_issue", "Create a new issue on a GitHub repository.", { type: "object", properties: { repo: repoProp, title: { type: "string" }, body: { type: "string", description: "Issue body (markdown)" } }, required: ["repo", "title"] }, (a) => c.createIssue(a.repo, a.title, a.body), true),
			fn("github_comment_issue", "Post a comment on a GitHub issue or PR.", { type: "object", properties: { repo: repoProp, number: { type: "number" }, body: { type: "string" } }, required: ["repo", "number", "body"] }, (a) => c.commentIssue(a.repo, a.number, a.body), true),
			fn("github_close_issue", "Close a GitHub issue. Pass reopen=true to reopen instead.", { type: "object", properties: { repo: repoProp, number: { type: "number" }, reopen: { type: "boolean" } }, required: ["repo", "number"] }, (a) => c.closeIssue(a.repo, a.number, a.reopen === true), true),
			fn("github_list_pulls", "List pull requests of a GitHub repository.", { type: "object", properties: { repo: repoProp, state: { type: "string", enum: ["open", "closed", "all"] } }, required: ["repo"] }, (a) => c.listPulls(a.repo, a.state)),
			fn("github_merge_pull", "Merge a GitHub pull request (merge/squash/rebase).", { type: "object", properties: { repo: repoProp, number: { type: "number" }, method: { type: "string", enum: ["merge", "squash", "rebase"] } }, required: ["repo", "number"] }, (a) => c.mergePull(a.repo, a.number, a.method), true),
			fn("github_comment_pull", "Comment on a GitHub pull request.", { type: "object", properties: { repo: repoProp, number: { type: "number" }, body: { type: "string" } }, required: ["repo", "number", "body"] }, (a) => c.commentPull(a.repo, a.number, a.body), true),
			fn("github_star_repo", "Star a GitHub repository with the bot's account.", { type: "object", properties: { repo: repoProp }, required: ["repo"] }, (a) => c.starRepo(a.repo), true),
			fn("github_my_repos", "List the repositories of the bot's own GitHub account.", { type: "object", properties: {} }, () => c.listRepos()),
		];
		return true;
	},
};
