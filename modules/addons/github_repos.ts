/// Addon: github (repository lifecycle half)
/// The mutating repository operations, each behind one of two config gates:
/// - allow_repo_creation: create + fork repos, edit metadata, create branches
/// - allow_repo_deletion: delete repos (needs a token with the delete_repo
///   scope) and delete branches (default branches are refused anyway)
/// When a gate is off the function is NOT registered, so it never reaches the
/// model's schema instead of being listed and then refused.

import { AgentFunction } from '../../src/modules/types.js';
import { GitHubClient, GitHubConfig, fn } from './github_client.js';

const repoProp = { type: 'string', description: "Repository as 'owner/repo' (or just the name when default_owner is set)" };

export function repoFunctions(c: GitHubClient, cfg: GitHubConfig): AgentFunction[] {
	const out: AgentFunction[] = [];

	if (cfg.allow_repo_creation) {
		out.push(
			fn(
				'github_create_repo',
				'Create a GitHub repository. Private by default and initialized with a README; owner defaults to addons.github.default_owner.',
				{
					type: 'object',
					properties: {
						name: { type: 'string', description: 'repo name without the owner part' },
						org: { type: 'string', description: 'owner (org or user); defaults to addons.github.default_owner' },
						description: { type: 'string', description: 'short repository description (max 350 chars)' },
						private: { type: 'boolean', description: 'true = private (default), false = public' },
						auto_init: { type: 'boolean', description: 'create a README/initial commit (default true)' }
					},
					required: ['name']
				},
				(a) => c.createRepo(a.name, a.org, a.description, a.private, a.auto_init),
				true
			),
			fn(
				'github_edit_repo',
				'Edit an existing repository: description, homepage or public/private visibility.',
				{
					type: 'object',
					properties: {
						repo: repoProp,
						description: { type: 'string', description: 'new description (max 350 chars)' },
						homepage: { type: 'string', description: 'homepage URL (must be http/https)' },
						private: { type: 'boolean', description: 'true = private, false = public' }
					},
					required: ['repo']
				},
				(a) => c.editRepo(a.repo, { description: a.description, homepage: a.homepage, isPrivate: a.private }),
				true
			),
			fn(
				'github_fork_repo',
				"Fork a repository into the bot's GitHub account (or an org). Only reads the source repo.",
				{
					type: 'object',
					properties: {
						repo: repoProp,
						org: { type: 'string', description: "fork into this org instead of the bot's account" }
					},
					required: ['repo']
				},
				(a) => c.forkRepo(a.repo, a.org),
				true
			),
			fn(
				'github_create_branch',
				"Create a branch in a repository (for example from 'main' before pushing changes).",
				{
					type: 'object',
					properties: {
						repo: repoProp,
						branch: { type: 'string', description: 'name of the new branch' },
						from: { type: 'string', description: "source branch (default: the repository's default branch)" }
					},
					required: ['repo', 'branch']
				},
				(a) => c.createBranch(a.repo, a.branch, a.from),
				true
			),
			fn(
				'github_apply_diff',
				'Push a COMMIT built from a unified diff: every hunk is applied to the current files on the branch and the result lands as one commit ' +
					'(create/modify/delete files, no git needed). The diff must match the file contents on that branch: a stale diff is refused, so read the file first when unsure.',
				{
					type: 'object',
					properties: {
						repo: repoProp,
						branch: { type: 'string', description: "branch to commit onto, e.g. 'main'" },
						diff: { type: 'string', description: "unified diff: 'diff --git a/f b/f' sections with ---/+++ and @@ hunks (max 300000 chars, 20 files)" },
						message: { type: 'string', description: 'commit message (optional)' }
					},
					required: ['repo', 'branch', 'diff']
				},
				(a) => c.applyDiff(a.repo, a.branch, a.diff, a.message),
				true
			)
		);
	}

	if (cfg.allow_repo_deletion) {
		out.push(
			fn(
				'github_delete_repo',
				'PERMANENTLY delete a repository with all its issues, PRs and code. Cannot be undone; needs a token with the delete_repo scope.',
				{ type: 'object', properties: { repo: repoProp }, required: ['repo'] },
				(a) => c.deleteRepo(a.repo),
				true
			),
			fn(
				'github_delete_branch',
				'Delete a branch in a repository. main/master are always refused.',
				{
					type: 'object',
					properties: {
						repo: repoProp,
						branch: { type: 'string' }
					},
					required: ['repo', 'branch']
				},
				(a) => c.deleteBranch(a.repo, a.branch),
				true
			)
		);
	}

	return out;
}
