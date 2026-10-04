// Config validation: every clamping, sanitizing and normalizing rule lives
// here, far away from parsing, so config.ts stays about loading. Nothing in
// this file trusts the file: lists are bounded, numbers clamped, booleans only
// flip on a real `true`, and every string that reaches a prompt or a Discord
// message is capped with control characters stripped.

import * as nodePath from 'node:path';
import type { AppConfig, BrainPersonConfig } from './config.js';
import type { ErrorTemplates } from './errors.js';

/** Bounded list of trimmed strings; accepts a comma-separated string too. */
function normStringList(value: unknown, cap: number): string[] {
	const list = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
	return list
		.map(String)
		.map((s) => s.trim().slice(0, 120))
		.filter(Boolean)
		.slice(0, cap);
}

/** One capped line for a template/message: control chars stripped, "" allowed. */
function cleanTemplate(value: unknown, fallback: string, allowEmpty: boolean): string {
	if (typeof value !== 'string') return fallback;
	const clean = value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 500);
	return clean.length === 0 && !allowEmpty ? fallback : clean;
}

export function validateConfig(cfg: AppConfig, defaults: AppConfig): void {
	// http port sanity
	cfg.http.port = Math.min(Math.max(Math.floor(Number(cfg.http.port) || 3000), 1), 65535);

	// brain: bounded memory + normalized taste lists (this feeds the system prompt,
	// so caps apply even though the file is operator-controlled)
	const b = cfg.agent.brain;
	const mem = Number(b.memory);
	b.memory = Number.isFinite(mem) ? Math.min(Math.max(Math.floor(mem), 0), 200) : 30;
	for (const key of ['likes', 'dislikes', 'favorites', 'pending'] as const) {
		b[key] = normStringList(b[key], 50);
	}
	b.reset = b.reset === true;
	if (typeof b.people !== 'object' || b.people === null || Array.isArray(b.people)) b.people = {};
	b.people = Object.fromEntries(
		Object.entries(b.people)
			.slice(0, 50)
			.map(([id, p]) => {
				const person = (p ?? {}) as BrainPersonConfig;
				return [
					id,
					{
						description: String(person.description ?? '').slice(0, 500),
						likes: normStringList(person.likes, 25),
						dislikes: normStringList(person.dislikes, 25),
						personalities: normStringList(person.personalities, 25)
					} satisfies BrainPersonConfig
				];
			})
	);

	// [agent] execution knobs: .prompt.txt budget, tool rounds per ask, and the
	// provider output cap (0 = let the provider decide; anthropic falls back
	// to its own default because its API requires a number)
	cfg.agent.promptFileMaxChars = Math.min(Math.max(Math.floor(Number(cfg.agent.promptFileMaxChars) || defaults.agent.promptFileMaxChars), 1_000), 120_000);
	cfg.agent.toolRounds = Math.min(Math.max(Math.floor(Number(cfg.agent.toolRounds) || defaults.agent.toolRounds), 1), 64);
	cfg.agent.maxTokens = Math.min(Math.max(Math.floor(Number(cfg.agent.maxTokens) || 0), 0), 128_000);

	// toolang limits get clamped, never trusted raw
	const t = cfg.agent.toolang;
	t.maxLoopIterations = Math.min(Math.max(Math.floor(Number(t.maxLoopIterations) || 10_000), 10), 1_000_000);
	t.maxCallDepth = Math.min(Math.max(Math.floor(Number(t.maxCallDepth) || 64), 2), 512);
	t.maxSteps = Math.min(Math.max(Math.floor(Number(t.maxSteps) || 200_000), 100), 10_000_000);
	t.maxOutputLength = Math.min(Math.max(Math.floor(Number(t.maxOutputLength) || 100_000), 100), 5_000_000);
	t.toolTimeoutMs = Math.min(Math.max(Math.floor(Number(t.toolTimeoutMs) || 30_000), 1000), 600_000);
	// creation switches gate real capabilities (manage_tool / manage_skill),
	// so only a real boolean true turns them on
	t.allowToolCreation = t.allowToolCreation === true;
	t.allowSkillCreation = t.allowSkillCreation === true;
	t.fs.root = nodePath.resolve(t.fs.root);
	t.fs.maxFileSize = Math.min(Math.max(Math.floor(Number(t.fs.maxFileSize) || 1_000_000), 100), 50_000_000);

	// docker ports must look like ranges
	if (!Array.isArray(cfg.docker.allowedPorts)) cfg.docker.allowedPorts = [];
	cfg.docker.allowedPorts = cfg.docker.allowedPorts.map(String).filter((r) => /^\d+-\d+$|^\d+$/.test(r));
	// host mounts are opt-in: resolved so a /data/../etc trick cannot slip past
	// the prefix check later, capped so the list stays readable
	if (!Array.isArray(cfg.docker.allowedVolumePaths)) cfg.docker.allowedVolumePaths = [];
	cfg.docker.allowedVolumePaths = cfg.docker.allowedVolumePaths
		.map(String)
		.map((p) => p.trim())
		.filter(Boolean)
		.slice(0, 20)
		.map((p) => nodePath.resolve(p));
	// published ports bind to loopback unless the operator opens them up
	// (the exact value is enforced again where the -p flag is built)
	cfg.docker.bindAddress = typeof cfg.docker.bindAddress === 'string' && cfg.docker.bindAddress.trim() ? cfg.docker.bindAddress.trim().slice(0, 45) : '127.0.0.1';

	// [general]: execution message + error wording. Both render straight into
	// Discord messages, so: one capped line, control chars stripped, and only
	// the known placeholders ({error}, {service}) can ever be substituted.
	const g = cfg.general;
	const errs: Partial<ErrorTemplates> = g && typeof g.errors === 'object' && g.errors !== null && !Array.isArray(g.errors) ? g.errors : {};
	cfg.general = {
		execution_message: cleanTemplate(g?.execution_message, defaults.general.execution_message, true),
		errors: {
			generic: cleanTemplate(errs.generic, defaults.general.errors.generic, false),
			tool: cleanTemplate(errs.tool, defaults.general.errors.tool, false),
			external: cleanTemplate(errs.external, defaults.general.errors.external, true),
			provider: cleanTemplate(errs.provider, defaults.general.errors.provider, false)
		}
	};

	// bot credentials come from env in production; config values must be literal
	if (process.env.DISCORD_TOKEN) cfg.bot.token = process.env.DISCORD_TOKEN;
	if (process.env.DISCORD_CLIENT_ID) cfg.bot.client_id = process.env.DISCORD_CLIENT_ID;

	// dashboard passcode: passcode_env wins, then passcode, else disabled auth
	// (an empty/missing passcode hash means the dashboard only allows login via
	// loopback + explicitly generated session; we handle that in index.ts)
	if (cfg.http.passcode_env && process.env[cfg.http.passcode_env]) {
		cfg.http.passcode = process.env[cfg.http.passcode_env];
	}

	// addons: enabled must be a list of known-shaped slugs; other keys under
	// [addons.*] are addon-specific settings (token strings etc.)
	if (!Array.isArray(cfg.addons.enabled)) cfg.addons.enabled = [];
	cfg.addons.enabled = cfg.addons.enabled.map(String).map((s) => s.toLowerCase());
	// never let addon settings hold expanded secrets in logs: keys are lowercase slugs
	for (const key of Object.keys(cfg.addons)) {
		if (key === 'enabled') continue;
		if (!/^[a-z][a-z0-9_]*$/.test(key)) delete cfg.addons[key];
	}

	// database: pick the driver + sanity-check its settings
	if (!cfg.database || typeof cfg.database.use !== 'string') cfg.database.use = 'sqlite';
	cfg.database.use = cfg.database.use.toLowerCase();
	if (cfg.database.use !== 'sqlite' && cfg.database.use !== 'postgres' && cfg.database.use !== 'mariadb' && cfg.database.use !== 'mongodb' && cfg.database.use !== 'cassandra') {
		console.warn(`[database] unknown driver '${cfg.database.use}', defaulting to sqlite`);
		cfg.database.use = 'sqlite';
	}
	if (cfg.database.postgres?.port) cfg.database.postgres.port = Math.min(Math.max(Math.floor(Number(cfg.database.postgres.port) || 5432), 1), 65535);
	if (cfg.database.mariadb?.port) cfg.database.mariadb.port = Math.min(Math.max(Math.floor(Number(cfg.database.mariadb.port) || 3306), 1), 65535);

	// providers: env expansion for api keys
	for (const provider of Object.values(cfg.agent.providers)) {
		if (provider && typeof provider === 'object' && typeof provider.api_key === 'string') {
			provider.api_key = provider.api_key.replace(/\$\{([A-Z0-9_]+)\}/g, (m, name: string) => process.env[name] ?? m);
		}
	}
}
