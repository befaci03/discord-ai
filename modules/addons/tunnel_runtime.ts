/// Addon: tunnel (runtime half)
/// One cloudflared child process, wrapped: spawn without a shell, token via
/// env only (never argv, never logs), route discovery from cloudflared's own
/// output, clean kill on process exit. Shared by the base tunnel and every
/// agent-created quick route, so the process rules exist in exactly one place.
///
/// Also home to the validators every tunnel call goes through: a "service"
/// must be a local HTTP target (that is what a tunnel is for), a hostname
/// must be a plain hostname AND inside addons.tunnel.allowed_domains, and the
/// tunnel id / credentials path are charset-checked before they can reach a
/// YAML file or an argv.

import { spawn, ChildProcess } from 'node:child_process';
import { AppConfig } from '../../src/utils/config.js';
import { Addon, AgentFunction } from '../../src/modules/types.js';

export const STARTUP_TIMEOUT_MS = 20_000;
const POLL_MS = 100;
const MAX_LOG_LINES = 40;
const MAX_LINE_CHARS = 400;
/** only ever accept an ephemeral route hostname printed by cloudflared itself */
const QUICK_URL_RE = /https:\/\/[a-z0-9-]{1,63}\.trycloudflare\.com/i;
const SERVICE_RE = /^https?:\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]{1,253})(:\d{1,5})?(\/[^\s]{0,500})?$/;
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;
const UNEXPANDED_ENV_RE = /^\$\{[A-Z0-9_]+\}$/;
/** tunnel id / credentials path: yaml-safe, no quotes, no spaces, no newlines */
const TUNNEL_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const CRED_PATH_RE = /^[A-Za-z0-9._\-/]{1,400}$/;
/** IPv4/IPv6 literals we accept as "local" service targets */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const PRIVATE_V4 = [{ octets: [127] }, { octets: [10] }, { octets: [192, 168] }, { octets: [172, 16] }, { octets: [169, 254] }, { octets: [0] }];

export type TunnelMode = 'quick' | 'named';

export interface TunnelConfig {
	mode: TunnelMode;
	binary: string;
	/** local target the tunnel forwards to, e.g. http://127.0.0.1:3000 */
	service: string;
	/** named mode: your public hostname (operator-owned, never model input) */
	hostname?: string;
	/** named mode only; never logged, never returned */
	token?: string;
	/** hostnames the AGENT may publish, exact or "*.example.com" (empty = none) */
	allowed_domains: string[];
	/** may the agent create/edit/remove routes at all */
	allow_route_creation: boolean;
	/** locally managed tunnel (uuid or name): enables hostname routes */
	tunnel_id?: string;
	/** credentials json for that tunnel; "" = cloudflared's default location */
	credentials_file?: string;
}

/**
 * A service target must be something this box can actually reach. Publishing
 * an arbitrary public URL through your tunnel would make the agent an open
 * proxy, so only loopback / private / link-local targets are accepted.
 */
export function isLocalService(service: string): boolean {
	const m = SERVICE_RE.exec(service);
	if (!m) return false;
	const host = (m[1] ?? '').toLowerCase();
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || host === '[::1]') return true;
	if (host.startsWith('[')) return host.startsWith('[fc') || host.startsWith('[fd') || host.startsWith('[fe80'); // v6 ULA/link-local
	const v4 = IPV4_RE.exec(host);
	if (!v4) return false; // bare hostnames other than localhost: resolve-dependent, refused
	const octets = v4.slice(1, 5).map(Number);
	if (octets.some((o) => o > 255)) return false;
	return PRIVATE_V4.some((p) => p.octets.every((o, i) => octets[i] === o));
}

/** Normalize + validate a service URL (throws with a fixable message). */
export function checkService(value: unknown): string {
	const s = String(value ?? '').trim();
	if (s.length === 0 || s.length > 512 || !SERVICE_RE.test(s)) {
		throw new Error('tunnel: service must look like http://host[:port][/path]');
	}
	if (!isLocalService(s)) {
		throw new Error(`tunnel: service '${s.slice(0, 80)}' is not a local address (loopback/private only: a tunnel must not proxy arbitrary public hosts)`);
	}
	return s;
}

/** Exact match or "*.example.com" suffix match against the operator allowlist. */
export function domainAllowed(hostname: string, allowed: string[]): boolean {
	const h = hostname.toLowerCase();
	return allowed.some((entry) => {
		const e = entry.trim().toLowerCase();
		if (e.length === 0) return false;
		if (e.startsWith('*.')) return h.endsWith(e.slice(1)) && h.length > e.length - 1;
		return h === e;
	});
}

/** Validate a model-supplied hostname and check it against allowed_domains. */
export function checkHostname(value: unknown, allowed: string[]): string {
	const h = String(value ?? '')
		.trim()
		.toLowerCase();
	if (h.length === 0 || h.length > 253 || !HOSTNAME_RE.test(h)) {
		throw new Error('tunnel: hostname must be a plain hostname, e.g. app.example.com');
	}
	if (allowed.length === 0) {
		throw new Error('tunnel: publishing hostnames is not allowed (set addons.tunnel.allowed_domains, e.g. ["example.com", "*.example.com"])');
	}
	if (!domainAllowed(h, allowed)) {
		throw new Error(`tunnel: hostname '${h}' is not in addons.tunnel.allowed_domains (${allowed.join(', ')})`);
	}
	return h;
}

export function checkTunnelId(value: unknown): string {
	const s = String(value ?? '').trim();
	if (!TUNNEL_ID_RE.test(s)) throw new Error('tunnel: tunnel_id must be a uuid or a plain name (letters, digits, . _ -)');
	return s;
}

export function checkCredentialsPath(value: unknown): string {
	const s = String(value ?? '').trim();
	if (!CRED_PATH_RE.test(s)) throw new Error('tunnel: credentials_file must be an absolute path without spaces or quotes');
	return s;
}

export interface TunnelStatus {
	mode: TunnelMode;
	running: boolean;
	connected: boolean;
	/** quick: the ephemeral route; named: the configured hostname (when running) */
	url: string;
	/** the operator's hostname, always reported so it can be announced */
	hostname: string;
	/** local target the tunnel forwards to */
	service: string;
	uptime_sec: number;
	error?: string;
	recent: string[];
}

/** The protected base rule: operator hostname + service, never model input. */
export interface RouteBase {
	hostname?: string;
	service: string;
}

export class TunnelRuntime {
	private child: ChildProcess | null = null;
	private url = '';
	private connected = false;
	private startedAt = 0;
	private lastError = '';
	private exited = false;
	private exitHook: (() => void) | null = null;
	private recent: string[] = [];

	constructor(
		private cfg: Pick<TunnelConfig, 'mode' | 'binary' | 'service' | 'hostname' | 'token'>,
		/** extra argv (e.g. --config <file> run <id>), empty for quick/base */
		private extraArgs: string[] = []
	) {}

	async start(): Promise<void> {
		const args =
			this.extraArgs.length > 0
				? ['tunnel', '--no-autoupdate', ...this.extraArgs]
				: this.cfg.mode === 'quick'
					? ['tunnel', '--no-autoupdate', '--url', this.cfg.service]
					: ['tunnel', '--no-autoupdate', 'run'];
		const env: NodeJS.ProcessEnv = { ...process.env };
		// token goes through env, never argv: `ps aux` must not show it
		if (this.cfg.mode === 'named' && this.cfg.token) env.TUNNEL_TOKEN = this.cfg.token;

		const child = spawn(this.cfg.binary, args, {
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
			shell: false // args are never handed to a shell
		});
		this.child = child;
		this.startedAt = Date.now();

		// the bot's SIGINT/SIGTERM handlers call process.exit(); an "exit"
		// listener still runs then, so cloudflared dies with us either way
		this.exitHook = () => {
			try {
				child.kill('SIGTERM');
			} catch {
				/* already gone */
			}
		};
		process.once('exit', this.exitHook);

		child.on('error', (err: Error) => {
			this.lastError = err.message.includes('ENOENT') ? `cloudflared not found ('${this.cfg.binary}') - install it or set addons.tunnel.binary` : `tunnel: ${err.message}`;
			this.exited = true;
		});
		child.on('exit', (code: number | null, signal: string | null) => {
			if (this.child === child) this.child = null;
			this.exited = true;
			this.url = '';
			this.connected = false;
			this.note(`cloudflared exited (code=${code ?? '?'} signal=${signal ?? '?'})`);
		});
		const onData = (chunk: Buffer | string) => this.consume(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
		child.stdout?.on('data', onData);
		child.stderr?.on('data', onData);

		await this.waitForReady();
	}

	/** stop the child and drop the process-exit hook (also used on failures) */
	stop(): void {
		if (this.exitHook) {
			process.removeListener('exit', this.exitHook);
			this.exitHook = null;
		}
		const child = this.child;
		this.child = null;
		if (child && child.exitCode === null) {
			try {
				child.kill('SIGTERM');
			} catch {
				/* already gone */
			}
		}
		this.url = '';
		this.connected = false;
	}

	isRunning(): boolean {
		return this.child !== null && this.child.exitCode === null;
	}

	/** resolve once a route is published, reject if cloudflared dies first */
	private waitForReady(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + STARTUP_TIMEOUT_MS;
			const timer = setInterval(() => {
				const finish = (err?: Error): void => {
					clearInterval(timer);
					if (err) {
						this.stop();
						reject(err);
					} else {
						resolve();
					}
				};
				if (this.exited) {
					return finish(new Error(this.lastError || 'tunnel: cloudflared exited before publishing a route'));
				}
				// named tunnels with ingress rules announce themselves through
				// the connection log, not through a trycloudflare url
				if (this.extraArgs.length > 0 && this.connected) return finish();
				if (this.cfg.mode === 'quick' && this.url) return finish();
				if (this.cfg.mode === 'named' && this.connected) return finish();
				if (Date.now() >= deadline) {
					// named tunnels may still be handshaking: leave them running;
					// quick tunnels are worthless without their url, so they hard-fail
					const ephemeral = this.cfg.mode === 'quick' && this.extraArgs.length === 0;
					if (!ephemeral && this.child) return finish();
					return finish(new Error('tunnel: timed out waiting for cloudflared to publish a route'));
				}
			}, POLL_MS);
		});
	}

	private consume(chunk: string): void {
		for (const raw of chunk.split('\n')) {
			let line = raw.trim();
			if (line.length === 0) continue;
			if (line.length > MAX_LINE_CHARS) line = line.slice(0, MAX_LINE_CHARS);
			line = this.redact(line);
			this.note(line);
			if (this.cfg.mode === 'quick' && !this.url) {
				const m = line.match(QUICK_URL_RE);
				if (m) this.url = m[0];
			}
			if (/registered tunnel connection/i.test(line)) this.connected = true;
			if (!this.exited && /\berror\b/i.test(line)) this.lastError = line;
		}
	}

	private note(line: string): void {
		this.recent.push(line);
		if (this.recent.length > MAX_LOG_LINES) this.recent.shift();
	}

	/** belt and braces: if cloudflared ever echoes the token, it never leaves */
	private redact(line: string): string {
		const t = this.cfg.token;
		if (t && t.length >= 6 && line.includes(t)) return line.split(t).join('[redacted]');
		return line;
	}

	status(): TunnelStatus {
		const running = this.isRunning();
		const hostname = this.cfg.hostname ?? '';
		const url = this.cfg.mode === 'quick' ? this.url : hostname ? `https://${hostname}` : '';
		return {
			mode: this.cfg.mode,
			running,
			connected: this.connected,
			url: running ? url : '',
			hostname,
			service: this.cfg.service,
			uptime_sec: running ? Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000)) : 0,
			error: this.lastError || undefined,
			recent: this.recent.slice(-5)
		};
	}
}

/** Tiny builder shared by the tunnel function list. */
export function fn(name: string, description: string, parameters: Record<string, unknown>, execute: (args: Record<string, unknown>) => Promise<unknown>, dangerous = false): AgentFunction {
	return { name, description, parameters, execute, dangerous };
}

/** Raw [addons.tunnel] settings (untyped on purpose, see config.addons). */
export function rawSection(config: AppConfig): Record<string, unknown> {
	return (config.addons as unknown as Record<string, Record<string, unknown>>).tunnel ?? {};
}
