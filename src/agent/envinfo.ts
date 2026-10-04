// The "### Your environment" system-prompt block: config facts the model
// cannot discover on its own. Without it the model guesses port ranges,
// invents sandbox limits and offers capabilities that are switched off.
// Pure function of config + active addons: no secrets, ever (token presence
// is reported, the value never is).

import { AppConfig } from '../utils/config.js';

/** Raw addon settings are untyped on purpose (see config.addons). */
function addonSection(config: AppConfig, name: string): Record<string, unknown> {
	return (config.addons as unknown as Record<string, Record<string, unknown>>)[name] ?? {};
}

function bool(v: unknown): boolean {
	return v === true;
}

function list(v: unknown): string[] {
	return Array.isArray(v)
		? v
				.map(String)
				.map((s) => s.trim())
				.filter(Boolean)
		: [];
}

/** The dashboard host the operator would type, never a wildcard bind. */
function publicHost(host: string): string {
	return host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host;
}

export interface EnvInfoOptions {
	/** addons that actually initialized (falls back to addons.enabled) */
	activeAddons?: string[];
}

/**
 * One bounded block for the system prompt. Every line is a fact the model
 * would otherwise have to guess: port ranges, sandbox roots, which creation
 * switches are on, what the tunnel publishes.
 */
export function environmentBlock(config: AppConfig, opts: EnvInfoOptions = {}): string {
	const active = new Set(opts.activeAddons ?? config.addons.enabled);
	const lines: string[] = ['### Your environment', 'Facts about this host, use them instead of guessing:'];

	// docker: the port range question lives here
	const d = config.docker;
	if (d.enabled) {
		const ports = d.allowedPorts.length > 0 ? d.allowedPorts.join(', ') : '(empty: every published port is refused)';
		const mounts = d.allowedVolumePaths.length > 0 ? d.allowedVolumePaths.join(', ') : 'none (host mounts refused, see [docker].allowed_volume_paths)';
		lines.push(
			`- docker: ON. Host ports you may publish: ${ports} (bound to ${d.bindAddress}: loopback = only this machine reaches them). A port must fall inside one of those ranges; 0 = publish no port. ` +
				`Host paths you may mount into containers: ${mounts}. ` +
				`Your volumes: give a volume id and it resolves to ${config.agent.toolang.fs.root}/.docker-vols/<volume_id> (mount with the volume/volume_path args on docker_create, or docker_manage action=mount); the sandbox store needs no allowed_volume_paths entry. ` +
				`Max containers: ${d.maxContainers}. Default image: ${d.defaultImage}. Blocked image prefixes: ${d.disallowedImages.join(', ') || 'none'}` +
				`${d.allowedImages && d.allowedImages.length > 0 ? `. Allowed images: ${d.allowedImages.join(', ')}` : ''}.`
		);
	} else {
		lines.push('- docker: OFF. Every docker_* tool refuses to run until [docker].enabled = true in config.toml.');
	}

	// sandboxed interpreter
	const fs = config.agent.toolang.fs;
	lines.push(`- filesystem sandbox: root ${fs.root} (writes ${fs.allowWrite ? 'allowed' : 'read-only'}, max file ${fs.maxFileSize} bytes). ` + 'Anything outside that root is unreachable.');
	const node = config.agent.toolang.node;
	lines.push(
		node.enabled
			? `- shell on the host (node.child_proc.run): allowed, timeout ${node.timeoutMs}ms${node.allowedCommands && node.allowedCommands.length > 0 ? `, allowlist: ${node.allowedCommands.join(', ')}` : ''}.`
			: '- shell on the host (node.child_proc.run): disabled, do not pretend you can run shell commands.'
	);

	// outbound http
	const h = config.agent.toolang.http;
	lines.push(
		`- outbound http from tools: ${h.blockPrivate ? 'private/loopback addresses refused (SSRF guard)' : 'private addresses allowed'}` +
			`${h.allowedHosts && h.allowedHosts.length > 0 ? `, allowlist: ${h.allowedHosts.join(', ')}` : ''}` +
			`${h.blockedHosts && h.blockedHosts.length > 0 ? `, blocked: ${h.blockedHosts.join(', ')}` : ''}` +
			`, response cap ${h.maxResponseBytes} bytes, timeout ${h.timeoutMs}ms.`
	);

	// cloudflare tunnel
	if (active.has('tunnel')) {
		const t = addonSection(config, 'tunnel');
		const mode = t.mode === 'named' ? 'named' : 'quick';
		const hostname = typeof t.hostname === 'string' ? t.hostname.trim() : '';
		const service = typeof t.service === 'string' && t.service.trim() ? String(t.service).trim() : 'the dashboard';
		const allowedDomains = list(t.allowed_domains);
		const mayCreate = bool(t.allow_route_creation);
		lines.push(
			`- cloudflare tunnel: ${mode} mode, publishes ${service}` +
				`${hostname ? ` at https://${hostname} (operator-owned: you can read it with tunnel_status but never change or remove it)` : ''}. ` +
				`Route management: ${mayCreate ? 'you may create/edit/remove routes with tunnel_create_route/tunnel_edit_route/tunnel_remove_route' : 'read-only (tunnel_list_routes/tunnel_status); allow_route_creation is off'}. ` +
				`Hostnames you may publish: ${allowedDomains.length > 0 ? allowedDomains.join(', ') : 'none (addons.tunnel.allowed_domains is empty)'}.`
		);
	}

	// github
	if (active.has('github')) {
		const g = addonSection(config, 'github');
		const envToken = typeof process.env.GITHUB_TOKEN === 'string' ? process.env.GITHUB_TOKEN.trim() : '';
		const cfgToken = typeof g.token === 'string' ? g.token.trim() : '';
		// an unexpanded ${VAR} (or an empty string) is NOT a token: reporting
		// "configured" would send the model off to fail every write call
		const hasToken = envToken.length > 0 || (cfgToken.length > 0 && !/^\$\{[A-Z0-9_]+\}$/.test(cfgToken));
		const owner = typeof g.default_owner === 'string' && g.default_owner.trim() ? String(g.default_owner).trim() : 'not set (pass owner/repo)';
		const allowed = list(g.allowed_repos);
		lines.push(
			`- github: token ${hasToken ? 'configured' : 'MISSING (every write call fails until GITHUB_TOKEN is set)'}, default owner ${owner}, ` +
				`repo allowlist: ${allowed.length > 0 ? allowed.join(', ') : 'none (any repo the token can reach)'}, ` +
				`create/fork/edit repo + create branch: ${bool(g.allow_repo_creation) ? 'allowed' : 'refused (allow_repo_creation is off)'}, ` +
				`delete repo/branch: ${bool(g.allow_repo_deletion) ? 'allowed' : 'refused (allow_repo_deletion is off)'}.`
		);
	}

	// email
	if (active.has('smtp')) {
		const s = addonSection(config, 'smtp');
		const from = typeof s.from === 'string' && s.from.trim() ? String(s.from).trim() : 'unset';
		const recipients = list(s.allowed_recipients);
		lines.push(`- email (smtp): sent as ${from}, recipients: ${recipients.length > 0 ? recipients.join(', ') : 'any address (operator chose not to restrict)'}.`);
	}

	// scheduled jobs
	if (active.has('cron')) {
		const c = addonSection(config, 'cron');
		const channels = list(c.allowed_channels);
		const max = Number(c.max_jobs ?? 10);
		lines.push(
			`- cron: schedule jobs with cron_add (5-field cron, @daily or "every 30m"): ${bool(c.allow_job_creation) ? 'you may add/remove/run jobs' : 'read-only (cron_list), allow_job_creation is off'}, ` +
				`max ${Number.isFinite(max) ? Math.min(Math.max(Math.floor(max), 1), 50) : 10} jobs, ` +
				`post into: ${channels.length > 0 ? channels.join(', ') : 'any channel you can see'}. Channel ids are in the per-ask context.`
		);
	}

	// self-management switches (the manage_* tools only exist when on)
	const t = config.agent.toolang;
	lines.push(
		`- self-management: manage_tool ${t.allowToolCreation ? 'AVAILABLE (create/edit/delete your own .tl tools)' : 'not available (allow_tool_creation is off)'}, ` +
			`manage_skill ${t.allowSkillCreation ? 'AVAILABLE (create/edit/delete your own skills)' : 'not available (allow_skill_creation is off)'}.`
	);

	// budgets + dashboard
	lines.push(`- tool budget: a single call times out after ${t.toolTimeoutMs}ms and its result reaches you truncated at 40k chars.`);
	lines.push(`- dashboard: http://${publicHost(config.http.host)}:${config.http.port} (private, passcode protected).`);
	lines.push(`- addons active: ${[...active].join(', ') || 'none'}.`);

	return lines.join('\n').slice(0, 4_000) + '\n';
}
