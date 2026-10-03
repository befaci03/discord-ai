/// Addon: tunnel
/// Publishes a local HTTP service through a Cloudflare Tunnel (cloudflared),
/// which creates a public HTTPS route without opening any firewall port.
///
/// modes:
/// - "quick" (default): cloudflared creates an ephemeral
///   https://<random>.trycloudflare.com route. No Cloudflare account, no
///   token. The URL changes on every restart (Cloudflare says so out loud).
/// - "named": runs a Cloudflare-managed tunnel (your own hostname). Two ways
///   to run it: with a token (CF_TUNNEL_TOKEN / addons.tunnel.token, ingress
///   rules come from the Cloudflare dashboard) or with addons.tunnel.tunnel_id
///   (locally managed: THIS addon generates the ingress config, which is what
///   lets the agent manage hostname routes). The token is handed to
///   cloudflared through the child's ENVIRONMENT only: never argv, never
///   logs, never a response.
///
/// Agent surface: tunnel_status + tunnel_list_routes are read-only, always
/// there. tunnel_create_route / tunnel_edit_route / tunnel_remove_route only
/// exist when addons.tunnel.allow_route_creation = true, only touch routes the
/// agent created, and can only publish hostnames inside allowed_domains. The
/// operator's own hostname is write-protected: it is always the first ingress
/// rule and never part of the route table.
///
/// The children are spawned without a shell and killed when the process exits.

import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppConfig } from '../../src/utils/config.js';
import { Addon, AgentFunction } from '../../src/modules/types.js';
import { TunnelConfig, TunnelRuntime, TunnelStatus, RouteBase, fn, rawSection, checkCredentialsPath, checkTunnelId } from './tunnel_runtime.js';
import { RouteManager, RouteResult, MAX_ROUTES } from './tunnel_routes.js';

const SERVICE_HINT = /^https?:\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]{1,253})(:\d{1,5})?(\/[^\s]{0,500})?$/;
const UNEXPANDED_ENV_RE = /^\$\{[A-Z0-9_]+\}$/;
/** operator hostnames: plain hostname, optionally "*.example.com" */
const DOMAIN_ENTRY_RE = /^(\*\.)?[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;

function resolveService(config: AppConfig, value: unknown): string {
	if (typeof value === 'string' && value.trim().length > 0) {
		// operator config: URL shape only (the local-only rule is for the agent)
		const s = value.trim();
		if (s.length > 512 || !SERVICE_HINT.test(s)) {
			throw new Error('tunnel: addons.tunnel.service must look like http://host[:port][/path]');
		}
		return s;
	}
	// cloudflared runs on this box, so wildcard binds are rewritten to loopback
	let host = config.http.host;
	if (host === '0.0.0.0' || host === '::' || host === '') host = '127.0.0.1';
	return `http://${host}:${config.http.port}`;
}

function resolveToken(value: unknown): string | undefined {
	const fromEnv = process.env.CF_TUNNEL_TOKEN;
	let token = typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv.trim() : undefined;
	if (!token && typeof value === 'string' && value.trim().length > 0) {
		const t = value.trim();
		// an unexpanded ${VAR} reference means the env var was never set
		if (!UNEXPANDED_ENV_RE.test(t)) token = t;
	}
	if (token && (token.length < 10 || token.length > 4096)) throw new Error('tunnel: token length looks wrong');
	return token;
}

function strList(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v
		.map(String)
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean)
		.slice(0, 20);
}

function getConfig(config: AppConfig): TunnelConfig {
	const raw = rawSection(config);
	const mode = raw.mode === undefined ? 'quick' : String(raw.mode);
	if (mode !== 'quick' && mode !== 'named') throw new Error("tunnel: mode must be 'quick' or 'named'");
	const binary = typeof raw.binary === 'string' && raw.binary.trim().length > 0 ? raw.binary.trim() : 'cloudflared';
	if (binary.length > 512 || binary.includes('\0')) throw new Error('tunnel: addons.tunnel.binary looks wrong');

	// the operator's hostname: shape-checked only, never gated by allowed_domains
	let hostname: string | undefined;
	if (typeof raw.hostname === 'string' && raw.hostname.trim().length > 0) {
		const h = raw.hostname.trim().toLowerCase();
		if (h.length > 253 || !DOMAIN_ENTRY_RE.test(h)) throw new Error('tunnel: addons.tunnel.hostname must be a plain hostname');
		hostname = h;
	}

	// hostnames the AGENT may publish: entries must be real domains (or *.domain)
	const allowedDomains = strList(raw.allowed_domains).map((entry) => {
		if (!DOMAIN_ENTRY_RE.test(entry)) throw new Error(`tunnel: addons.tunnel.allowed_domains entry '${entry.slice(0, 60)}' is not a hostname`);
		return entry;
	});

	const tunnelId = typeof raw.tunnel_id === 'string' && raw.tunnel_id.trim().length > 0 ? checkTunnelId(raw.tunnel_id) : undefined;
	let credentialsFile = typeof raw.credentials_file === 'string' && raw.credentials_file.trim().length > 0 ? checkCredentialsPath(raw.credentials_file) : undefined;
	if (tunnelId && !credentialsFile) {
		// cloudflared's own default location; only added when it really exists
		const guess = path.join(os.homedir(), '.cloudflared', `${tunnelId}.json`);
		if (existsSync(guess)) credentialsFile = guess;
	}

	return {
		mode: mode as TunnelConfig['mode'],
		binary,
		service: resolveService(config, raw.service),
		hostname,
		token: mode === 'named' ? resolveToken(raw.token) : undefined,
		allowed_domains: allowedDomains,
		allow_route_creation: raw.allow_route_creation === true,
		tunnel_id: tunnelId,
		credentials_file: credentialsFile
	};
}

/** live runtime, set by init(); feeds tunnel_status and the startup note */
let runtime: TunnelRuntime | null = null;
/** agent-managed routes; set by init() (needs config) */
let routes: RouteManager | null = null;
let cfg: TunnelConfig | null = null;
/** the protected base rule: operator hostname + service, never model input */
let base: RouteBase = { service: '' };

/** Extra argv for a config-driven (locally managed) tunnel. */
function configArgs(configFile: string): string[] {
	return ['--config', configFile, 'run', cfg!.tunnel_id!];
}

/** (Re)write the ingress file and run the base tunnel against it. */
async function startBase(withConfig: boolean): Promise<void> {
	if (!cfg) throw new Error('tunnel: not configured');
	const args = withConfig && routes && cfg.tunnel_id ? configArgs(routes.writeConfig(base)) : [];
	const next = new TunnelRuntime({ mode: cfg.mode, binary: cfg.binary, service: cfg.service, hostname: cfg.hostname, token: cfg.token }, args);
	try {
		await next.start();
	} catch (err) {
		next.stop();
		throw err;
	}
	runtime = next;
}

export const Tunnel: Addon = {
	name: 'tunnel',
	description: 'Publishes the dashboard (or another local service) through a Cloudflare Tunnel with a public HTTPS route',
	functions: [], // built in init() (needs config)
	init: async (config: AppConfig) => {
		cfg = getConfig(config);
		base = { hostname: cfg.hostname, service: cfg.service };
		if (cfg.mode === 'quick' && cfg.tunnel_id) {
			// a locally managed tunnel is only reachable in named mode
			console.warn('[tunnel] addons.tunnel.tunnel_id is set but mode = "quick": quick tunnels only make ephemeral URLs (use mode = "named" for hostname routes)');
		}
		// named mode needs either a token or a locally managed tunnel id
		if (cfg.mode === 'named' && !cfg.token && !cfg.tunnel_id) return false;

		routes = new RouteManager(cfg);
		// a host-route change rewrites the config and restarts the one process
		// that serves them (rollback paths call this again with old state)
		routes.onChanged = async () => {
			runtime?.stop();
			runtime = null;
			// startBase rewrites the ingress file from the manager's CURRENT
			// state, so a rollback + second call restores the old rules
			await startBase(true);
		};

		try {
			await startBase(Boolean(cfg.tunnel_id));
		} catch (err) {
			runtime = null;
			throw err;
		}
		if (cfg.tunnel_id && cfg.token) {
			// be loud about the precedence instead of silently dropping one
			console.warn('[tunnel] addons.tunnel.tunnel_id and a token are both set: tunnel_id wins (local ingress config)');
		}

		Tunnel.functions = buildFunctions(cfg, () => runtime?.status() ?? null, routes);
		return true;
	},
	/** printed by the registry at startup: the public URL/domain lands in the log */
	startupNote: () => {
		const s = runtime?.status();
		const c = cfg;
		if (!c) return undefined;
		const bits: string[] = [];
		if (c.mode === 'quick') {
			if (s?.running && s.url) bits.push(`tunnel published ${s.url} (quick, forwarding to ${c.service})`);
			else return s?.error ? `tunnel warning: ${s.error}` : undefined;
		} else {
			const host = c.hostname ? `https://${c.hostname}` : '(no hostname configured)';
			const kind = c.tunnel_id ? `named, local ingress via tunnel_id ${c.tunnel_id}` : 'named, token';
			bits.push(`tunnel started (${kind}): ${host} -> ${c.service}`);
			if (c.hostname) bits.push('tunnel hostname is operator-owned: the agent can read it but never change or remove it');
			if (s && !s.running && s.error) bits.push(`tunnel warning: ${s.error}`);
		}
		if (c.allow_route_creation) {
			const targets = c.allowed_domains.length > 0 ? c.allowed_domains.join(', ') : 'none (allowed_domains is empty, quick URLs only)';
			bits.push(`tunnel routes: agent may create/edit/remove routes (max ${MAX_ROUTES}), publishable hostnames: ${targets}`);
		}
		return bits.join(' | ');
	}
};

/**
 * The agent-facing function list. Split out (and parameterized) so the
 * allow_route_creation gate can be tested without spawning cloudflared.
 */
export function buildFunctions(c: TunnelConfig, status: () => TunnelStatus | null, routes: RouteManager): AgentFunction[] {
	const out: AgentFunction[] = [
		fn(
			'tunnel_status',
			'Get the state of the base Cloudflare Tunnel: public URL/hostname, uptime, last errors, local service.',
			{ type: 'object', properties: {} },
			async (): Promise<TunnelStatus> =>
				status() ?? { mode: c.mode, running: false, connected: false, url: '', hostname: c.hostname ?? '', service: c.service, uptime_sec: 0, error: 'tunnel not running', recent: [] }
		),
		fn('tunnel_list_routes', "List every public route: the operator's base tunnel plus the ones you created (id, kind, service, url, running).", { type: 'object', properties: {} }, async () => {
			const s = status();
			return {
				base: s ?? { running: false, url: '', hostname: c.hostname ?? '', service: c.service },
				// hostname routes live inside the base process: report ITS state
				// instead of claiming "running" while the tunnel is down
				routes: routes.list().map((r) => (r.kind === 'hostname' ? { ...r, running: s?.running ?? false, uptime_sec: s?.uptime_sec ?? 0 } : r)),
				max_routes: MAX_ROUTES,
				allowed_domains: c.allowed_domains
			};
		})
	];

	if (c.allow_route_creation) {
		out.push(
			fn(
				'tunnel_create_route',
				'Publish a local HTTP service under a NEW public URL. Omit hostname for an ephemeral https://xxx.trycloudflare.com URL; ' +
					'pass hostname to bind one of your allowed domains (needs a locally managed tunnel + DNS already pointing at it). ' +
					'service must be a local address (http://127.0.0.1:8080 and friends).',
				{
					type: 'object',
					properties: {
						service: { type: 'string', description: 'local target, e.g. http://127.0.0.1:8080' },
						hostname: { type: 'string', description: 'optional public hostname from allowed_domains, e.g. app.example.com' }
					},
					required: ['service']
				},
				async (a): Promise<RouteResult> => await routes.create(a.service, a.hostname),
				true
			),
			fn(
				'tunnel_edit_route',
				'Point an existing route at another local service (quick routes), or change its service/hostname (hostname routes).',
				{
					type: 'object',
					properties: {
						route_id: { type: 'string', description: 'id from tunnel_list_routes' },
						service: { type: 'string', description: 'new local target, e.g. http://127.0.0.1:9000' },
						hostname: { type: 'string', description: 'hostname routes only: new hostname from allowed_domains' }
					},
					required: ['route_id']
				},
				async (a): Promise<RouteResult> => await routes.edit(a.route_id, a.service, a.hostname),
				true
			),
			fn(
				'tunnel_remove_route',
				"Stop publishing a route you created (its public URL dies). The operator's base tunnel is not a route and cannot be removed.",
				{ type: 'object', properties: { route_id: { type: 'string', description: 'id from tunnel_list_routes' } }, required: ['route_id'] },
				async (a): Promise<RouteResult> => await routes.remove(a.route_id),
				true
			)
		);
	}
	return out;
}
