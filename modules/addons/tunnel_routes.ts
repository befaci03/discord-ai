/// Addon: tunnel (routes half)
/// Public routes the AGENT may manage, all behind allow_route_creation:
/// - kind "quick": its own `cloudflared tunnel --url <service>` child, gets an
///   ephemeral https://xxx.trycloudflare.com URL (no account needed). Works
///   anywhere cloudflared is installed.
/// - kind "hostname": an ingress rule for an operator-approved domain. These
///   live in ONE generated config file that the base named tunnel runs, so
///   every hostname stays in a single process (cloudflared load-balances
///   connectors per tunnel: two processes with different ingress rules would
///   answer 404 half the time). Needs addons.tunnel.tunnel_id, because token
///   tunnels take their ingress rules from the Cloudflare dashboard and
///   cannot be steered from here.
//
// Rules that exist on purpose:
// - the operator's own hostname (addons.tunnel.hostname) is NEVER a route:
//   it is always the first ingress rule and the agent cannot edit or remove it
// - allowed_domains decides which hostnames may be published at all; empty
//   list = no hostname routes, ever
// - services must be local (loopback/private), so the tunnel can never be
//   turned into an open proxy to someone else's host
// - routes are runtime state: a restart forgets agent-created routes (their
//   URLs would change anyway), the base tunnel is unaffected

import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { TunnelConfig, TunnelRuntime, checkService, checkHostname } from './tunnel_runtime.js';

const MAX_ROUTES = 24;
export { MAX_ROUTES };

export interface RouteInfo {
	id: string;
	kind: 'quick' | 'hostname';
	service: string;
	/** empty for quick routes (Cloudflare picks the hostname) */
	hostname: string;
	url: string;
	running: boolean;
	uptime_sec: number;
	error?: string;
}

/** What create/edit hand back to the model (no internal paths, no tokens). */
export interface RouteResult {
	id: string;
	kind: 'quick' | 'hostname';
	service: string;
	hostname?: string;
	url: string;
	note?: string;
}

interface QuickRoute {
	id: string;
	service: string;
	createdAt: number;
	runtime: TunnelRuntime;
}

interface HostRoute {
	id: string;
	service: string;
	hostname: string;
	createdAt: number;
}

export class RouteManager {
	private quick = new Map<string, QuickRoute>();
	private host = new Map<string, HostRoute>();
	/** set by tunnel.ts: rewrites the ingress config and restarts the base tunnel */
	onChanged: (() => Promise<void>) | null = null;

	constructor(private cfg: TunnelConfig) {}

	// ---------------- queries ----------------

	list(): RouteInfo[] {
		const out: RouteInfo[] = [];
		for (const r of this.quick.values()) {
			const s = r.runtime.status();
			out.push({
				id: r.id,
				kind: 'quick',
				service: r.service,
				hostname: '',
				url: s.url,
				running: s.running,
				uptime_sec: s.uptime_sec,
				error: s.error
			});
		}
		for (const r of this.host.values()) {
			out.push({
				id: r.id,
				kind: 'hostname',
				service: r.service,
				hostname: r.hostname,
				url: `https://${r.hostname}`,
				// the host routes live inside the base tunnel process
				running: true,
				uptime_sec: 0
			});
		}
		return out;
	}

	get size(): number {
		return this.quick.size + this.host.size;
	}

	hasHostRoutes(): boolean {
		return this.host.size > 0;
	}

	stopAll(): void {
		for (const r of this.quick.values()) r.runtime.stop();
		this.quick.clear();
	}

	// ---------------- mutations ----------------

	async create(serviceRaw: unknown, hostnameRaw?: unknown): Promise<RouteResult> {
		const service = checkService(serviceRaw);
		if (this.size >= MAX_ROUTES) throw new Error(`tunnel: route limit reached (${MAX_ROUTES}), remove one first`);
		const hostname = typeof hostnameRaw === 'string' ? hostnameRaw.trim() : '';

		if (hostname.length > 0) return await this.createHostnameRoute(service, hostname);

		const id = newId();
		const runtime = new TunnelRuntime({ mode: 'quick', binary: this.cfg.binary, service });
		const route: QuickRoute = { id, service, createdAt: Date.now(), runtime };
		this.quick.set(id, route);
		try {
			await runtime.start();
		} catch (err) {
			this.quick.delete(id);
			runtime.stop();
			throw err;
		}
		return { id, kind: 'quick', service, url: runtime.status().url };
	}

	private async createHostnameRoute(service: string, hostnameRaw: string): Promise<RouteResult> {
		const hostname = checkHostname(hostnameRaw, this.cfg.allowed_domains);
		this.requireLocalMode();
		for (const r of this.host.values()) {
			if (r.hostname === hostname) throw new Error(`tunnel: hostname '${hostname}' already has a route (use edit or remove)`);
		}
		const id = newId();
		this.host.set(id, { id, service, hostname, createdAt: Date.now() });
		try {
			await this.changed();
		} catch (err) {
			// rewrite the config from the rolled-back state too: a failed reload
			// may have written the file BEFORE the restart failed, and disk then
			// would keep publishing a route memory no longer knows about
			this.host.delete(id);
			await this.changed().catch(() => undefined);
			throw new Error(`tunnel: could not reload the ingress config (${(err as Error).message})`);
		}
		return {
			id,
			kind: 'hostname',
			service,
			hostname,
			url: `https://${hostname}`,
			note:
				`route added for ${hostname} -> ${service}. cloudflared does NOT create DNS: the hostname must already be a ` +
				`CNAME to <tunnel_id>.cfargotunnel.com in your zone, otherwise Cloudflare answers NXDOMAIN.`
		};
	}

	async edit(idRaw: unknown, serviceRaw?: unknown, hostnameRaw?: unknown): Promise<RouteResult> {
		const id = String(idRaw ?? '').trim();
		const hostnameArg = typeof hostnameRaw === 'string' ? hostnameRaw.trim() : '';

		const quick = this.quick.get(id);
		if (quick) {
			if (hostnameArg.length > 0) {
				throw new Error('tunnel: a quick route cannot gain a hostname (remove it and create a hostname route instead)');
			}
			const service = checkService(serviceRaw);
			// point the child at the new target: url changes anyway, so restart
			quick.runtime.stop();
			const runtime = new TunnelRuntime({ mode: 'quick', binary: this.cfg.binary, service });
			try {
				await runtime.start();
			} catch (err) {
				this.quick.delete(id);
				throw new Error(`tunnel: route ${id} was removed, the restart failed: ${(err as Error).message}`);
			}
			quick.service = service;
			quick.runtime = runtime;
			return { id, kind: 'quick', service, url: runtime.status().url };
		}

		const host = this.host.get(id);
		if (!host) throw new Error(`tunnel: unknown route '${id.slice(0, 32)}' (list them with tunnel_list_routes)`);
		const service = serviceRaw === undefined ? host.service : checkService(serviceRaw);
		const hostname = hostnameArg.length > 0 ? checkHostname(hostnameArg, this.cfg.allowed_domains) : host.hostname;
		if (hostname !== host.hostname) {
			for (const other of this.host.values()) {
				if (other.hostname === hostname && other.id !== id) throw new Error(`tunnel: hostname '${hostname}' already has a route`);
			}
		}
		const prev = { service: host.service, hostname: host.hostname };
		host.service = service;
		host.hostname = hostname;
		try {
			await this.changed();
		} catch (err) {
			host.service = prev.service;
			host.hostname = prev.hostname;
			await this.changed().catch(() => undefined);
			throw new Error(`tunnel: reload failed, the route was restored (${(err as Error).message})`);
		}
		return { id, kind: 'hostname', service, hostname, url: `https://${hostname}` };
	}

	async remove(idRaw: unknown): Promise<RouteResult> {
		const id = String(idRaw ?? '').trim();

		const quick = this.quick.get(id);
		if (quick) {
			this.quick.delete(id);
			quick.runtime.stop();
			return { id, kind: 'quick', service: quick.service, url: '' };
		}

		const host = this.host.get(id);
		if (!host) throw new Error(`tunnel: unknown route '${id.slice(0, 32)}' (list them with tunnel_list_routes)`);
		this.host.delete(id);
		try {
			await this.changed();
		} catch (err) {
			// keep state honest: put it back if the tunnel cannot drop the rule
			this.host.set(id, host);
			await this.changed().catch(() => undefined);
			throw new Error(`tunnel: could not reload the ingress config (${(err as Error).message})`);
		}
		return { id, kind: 'hostname', service: host.service, hostname: host.hostname, url: '' };
	}

	// ---------------- ingress config ----------------

	private requireLocalMode(): void {
		if (!this.cfg.tunnel_id) {
			throw new Error(
				'tunnel: hostname routes need a locally managed tunnel: set addons.tunnel.tunnel_id (from `cloudflared tunnel create <name>`). ' +
					'Token tunnels take their hostnames from the Cloudflare dashboard, so they cannot be changed from here.'
			);
		}
		if (this.cfg.mode !== 'named') {
			throw new Error('tunnel: hostname routes need mode = "named" (quick mode only makes ephemeral trycloudflare.com URLs)');
		}
	}

	/**
	 * The generated ingress file: protected operator hostname first, then the
	 * agent's host routes in creation order, then a catch-all. Every value was
	 * charset-validated before it gets near this YAML.
	 */
	buildConfig(base: { hostname?: string; service: string }): string {
		const lines: string[] = [`tunnel: ${this.cfg.tunnel_id}`];
		if (this.cfg.credentials_file) lines.push(`credentials-file: ${this.cfg.credentials_file}`);
		lines.push('ingress:');
		if (base.hostname) {
			lines.push(`  - hostname: ${base.hostname}`, `    service: ${base.service}`);
		}
		for (const r of [...this.host.values()].sort((a, b) => a.createdAt - b.createdAt)) {
			lines.push(`  - hostname: ${r.hostname}`, `    service: ${r.service}`);
		}
		// with a public hostname the dashboard must not leak on random hostnames
		lines.push(base.hostname ? '  - service: http_status:404' : `  - service: ${base.service}`);
		return lines.join('\n') + '\n';
	}

	/**
	 * Atomically write the ingress file (0600 in a 0700 dir, tmp+rename so
	 * cloudflared never sees a half-written config) and return its path.
	 */
	writeConfig(base: { hostname?: string; service: string }): string {
		const dir = path.join(process.cwd(), 'modules', '.tunnel');
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const file = path.join(dir, 'routes.yml');
		const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
		writeFileSync(tmp, this.buildConfig(base), { encoding: 'utf-8', mode: 0o600 });
		renameSync(tmp, file);
		return file;
	}

	/** A host route changed: tunnel.ts rewrites the config + restarts base. */
	private async changed(): Promise<void> {
		if (!this.onChanged) throw new Error('tunnel: no tunnel process is attached to hostname routes');
		await this.onChanged();
	}
}

/** Short, random, opaque: ids are handed to the model but never guessable. */
function newId(): string {
	return `r${randomBytes(4).toString('hex')}`;
}
