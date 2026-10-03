/// Addon: github
/// Gives the AGENT real GitHub account control as LLM-callable functions:
/// create/close/reopen/comment on issues, comment on PRs, merge PRs, star
/// repos, read issues/PRs/releases/branches, list own repos. The repository
/// lifecycle half (create/edit/fork/delete + branches) lives in
/// github_repos.ts behind allow_repo_creation / allow_repo_deletion.
/// Token from GITHUB_TOKEN env (required for anything that writes). Mutating
/// functions are flagged dangerous so the bot audit-logs their target. The
/// token never lands in logs or responses.

import { AppConfig } from '../../src/utils/config.js';
import { Addon, AgentFunction } from '../../src/modules/types.js';
import { GitHubClient, getConfig, fn } from './github_client.js';
import { repoFunctions } from './github_repos.js';

const repoProp = { type: 'string', description: "Repository as 'owner/repo'" };

export const GitHub: Addon = {
	name: 'github',
	description: 'GitHub account control for the agent: issues, PRs, comments, stars, repo browsing, and (behind allow_repo_* flags) repo create/delete',
	functions: [], // built in init() (needs config)
	init: (config: AppConfig) => {
		const cfg = getConfig(config);
		const token = process.env.GITHUB_TOKEN || cfg.token;
		const c = new GitHubClient(cfg, token);

		const core: AgentFunction[] = [
			fn('github_repo_info', 'Get metadata (stars, language, description) for a GitHub repository.', { type: 'object', properties: { repo: repoProp }, required: ['repo'] }, (a) =>
				c.repoInfo(a.repo)
			),
			fn(
				'github_list_issues',
				'List issues (open/closed/all) of a GitHub repository.',
				{ type: 'object', properties: { repo: repoProp, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, required: ['repo'] },
				(a) => c.listIssues(a.repo, a.state)
			),
			fn(
				'github_create_issue',
				'Create a new issue on a GitHub repository.',
				{ type: 'object', properties: { repo: repoProp, title: { type: 'string' }, body: { type: 'string', description: 'Issue body (markdown)' } }, required: ['repo', 'title'] },
				(a) => c.createIssue(a.repo, a.title, a.body),
				true
			),
			fn(
				'github_comment_issue',
				'Post a comment on a GitHub issue or PR.',
				{ type: 'object', properties: { repo: repoProp, number: { type: 'number' }, body: { type: 'string' } }, required: ['repo', 'number', 'body'] },
				(a) => c.commentIssue(a.repo, a.number, a.body),
				true
			),
			fn(
				'github_close_issue',
				'Close a GitHub issue. Pass reopen=true to reopen instead.',
				{ type: 'object', properties: { repo: repoProp, number: { type: 'number' }, reopen: { type: 'boolean' } }, required: ['repo', 'number'] },
				(a) => c.closeIssue(a.repo, a.number, a.reopen === true),
				true
			),
			fn(
				'github_list_pulls',
				'List pull requests of a GitHub repository.',
				{ type: 'object', properties: { repo: repoProp, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, required: ['repo'] },
				(a) => c.listPulls(a.repo, a.state)
			),
			fn(
				'github_merge_pull',
				'Merge a GitHub pull request (merge/squash/rebase).',
				{ type: 'object', properties: { repo: repoProp, number: { type: 'number' }, method: { type: 'string', enum: ['merge', 'squash', 'rebase'] } }, required: ['repo', 'number'] },
				(a) => c.mergePull(a.repo, a.number, a.method),
				true
			),
			fn(
				'github_comment_pull',
				'Comment on a GitHub pull request.',
				{ type: 'object', properties: { repo: repoProp, number: { type: 'number' }, body: { type: 'string' } }, required: ['repo', 'number', 'body'] },
				(a) => c.commentPull(a.repo, a.number, a.body),
				true
			),
			fn('github_star_repo', "Star a GitHub repository with the bot's account.", { type: 'object', properties: { repo: repoProp }, required: ['repo'] }, (a) => c.starRepo(a.repo), true),
			fn('github_my_repos', "List the repositories of the bot's own GitHub account.", { type: 'object', properties: {} }, () => c.listRepos()),
			fn('github_list_branches', 'List the branches of a GitHub repository (name + last commit sha).', { type: 'object', properties: { repo: repoProp }, required: ['repo'] }, (a) =>
				c.listBranches(a.repo)
			),
			fn('github_list_releases', 'List the latest releases of a GitHub repository.', { type: 'object', properties: { repo: repoProp }, required: ['repo'] }, (a) => c.listReleases(a.repo))
		];

		// lifecycle half: only registered when the operator opened its gate
		GitHub.functions = [...core, ...repoFunctions(c, cfg)];
		return true;
	}
};
