/// Addon: tunnel
/// Publishes a local HTTP service through a Cloudflare Tunnel (cloudflared),
/// which creates a public HTTPS route without opening any firewall port.
///
/// modes:
/// - "quick" (default): cloudflared creates an ephemeral
///   https://<random>.trycloudflare.com route. No Cloudflare account, no
///   token. The URL changes on every restart (Cloudflare says so out loud).
/// - "named": runs a Cloudflare-managed tunnel (your own hostname, configured
///   in the Zero Trust dashboard). The token comes from CF_TUNNEL_TOKEN or
///   addons.tunnel.token and is handed to cloudflared via the child's
///   ENVIRONMENT only: never argv (ps would show it), never logs, never a
///   response.
///
/// The agent gets exactly one read-only function: tunnel_status. No mutating
/// functions on purpose, an LLM should not be able to republish your infra.
/// The child is spawned without a shell and killed when the process exits.

import { spawn, ChildProcess } from "node:child_process";
import { AppConfig } from "../../src/utils/config.js";
import { Addon, AgentFunction } from "../../src/modules/types.js";

const STARTUP_TIMEOUT_MS = 20_000;
const POLL_MS = 100;
const MAX_LOG_LINES = 40;
const MAX_LINE_CHARS = 400;
/** only ever accept an ephemeral route hostname printed by cloudflared itself */
const QUICK_URL_RE = /https:\/\/[a-z0-9-]{1,63}\.trycloudflare\.com/i;
const SERVICE_RE = /^https?:\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]{1,253})(:\d{1,5})?(\/[^\s]{0,500})?$/;
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;
const UNEXPANDED_ENV_RE = /^\$\{[A-Z0-9_]+\}$/;

export type TunnelMode = "quick" | "named";

export interface TunnelConfig {
	mode: TunnelMode;
	binary: string;
	/** local target the tunnel forwards to, e.g. http://127.0.0.1:3000 */
	service: string;
	/** named mode: your public hostname (display only, set up in the CF dashboard) */
	hostname?: string;
	/** named mode only; never logged, never returned */
	token?: string;
}

function resolveService(config: AppConfig, value: unknown): string {
	if (typeof value === "string" && value.trim().length > 0) {
		const s = value.trim();
		if (s.length > 512 || !SERVICE_RE.test(s)) {
			throw new Error("tunnel: addons.tunnel.service must look like http://host[:port][/path]");
		}
		return s;
	}
	// cloudflared runs on this box, so wildcard binds are rewritten to loopback
	let host = config.http.host;
	if (host === "0.0.0.0" || host === "::" || host === "") host = "127.0.0.1";
	return `http://${host}:${config.http.port}`;
}

function resolveToken(value: unknown): string | undefined {
	const fromEnv = process.env.CF_TUNNEL_TOKEN;
	let token = typeof fromEnv === "string" && fromEnv.trim().length > 0 ? fromEnv.trim() : undefined;
	if (!token && typeof value === "string" && value.trim().length > 0) {
		const t = value.trim();
		// an unexpanded ${VAR} reference means the env var was never set
		if (!UNEXPANDED_ENV_RE.test(t)) token = t;
	}
	if (token && (token.length < 10 || token.length > 4096)) throw new Error("tunnel: token length looks wrong");
	return token;
}

function getConfig(config: AppConfig): TunnelConfig {
	const raw = (config.addons as unknown as Record<string, Record<string, unknown>>).tunnel ?? {};
	const mode = raw.mode === undefined ? "quick" : String(raw.mode);
	if (mode !== "quick" && mode !== "named") throw new Error("tunnel: mode must be 'quick' or 'named'");
	const binary = typeof raw.binary === "string" && raw.binary.trim().length > 0 ? raw.binary.trim() : "cloudflared";
	if (binary.length > 512 || binary.includes("\0")) throw new Error("tunnel: addons.tunnel.binary looks wrong");
	let hostname: string | undefined;
	if (typeof raw.hostname === "string" && raw.hostname.trim().length > 0) {
		const h = raw.hostname.trim().toLowerCase();
		if (h.length > 253 || !HOSTNAME_RE.test(h)) throw new Error("tunnel: addons.tunnel.hostname must be a plain hostname");
		hostname = h;
	}
	return {
		mode: mode as TunnelMode,
		binary,
		service: resolveService(config, raw.service),
		hostname,
		token: mode === "named" ? resolveToken(raw.token) : undefined,
	};
}

export interface TunnelStatus {
	mode: TunnelMode;
	running: boolean;
	connected: boolean;
	/** quick: the ephemeral route; named: the configured hostname (when running) */
	url: string;
	/** local target the tunnel forwards to */
	service: string;
	uptime_sec: number;
	error?: string;
	recent: string[];
}

class TunnelRuntime {
	private child: ChildProcess | null = null;
	private url = "";
	private connected = false;
	private startedAt = 0;
	private lastError = "";
	private exited = false;
	private exitHook: (() => void) | null = null;
	private recent: string[] = [];

	constructor(private cfg: TunnelConfig) {}

	async start(): Promise<void> {
		const args =
			this.cfg.mode === "quick"
				? ["tunnel", "--no-autoupdate", "--url", this.cfg.service]
				: ["tunnel", "--no-autoupdate", "run"];
		const env: NodeJS.ProcessEnv = { ...process.env };
		// token goes through env, never argv: `ps aux` must not show it
		if (this.cfg.mode === "named" && this.cfg.token) env.TUNNEL_TOKEN = this.cfg.token;

		const child = spawn(this.cfg.binary, args, {
			env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			shell: false, // args are never handed to a shell
		});
		this.child = child;
		this.startedAt = Date.now();

		// the bot's SIGINT/SIGTERM handlers call process.exit(); an "exit"
		// listener still runs then, so cloudflared dies with us either way
		this.exitHook = () => {
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		};
		process.once("exit", this.exitHook);

		child.on("error", (err: Error) => {
			this.lastError = err.message.includes("ENOENT")
				? `cloudflared not found ('${this.cfg.binary}') - install it or set addons.tunnel.binary`
				: `tunnel: ${err.message}`;
			this.exited = true;
		});
		child.on("exit", (code: number | null, signal: string | null) => {
			if (this.child === child) this.child = null;
			this.exited = true;
			this.url = "";
			this.connected = false;
			this.note(`cloudflared exited (code=${code ?? "?"} signal=${signal ?? "?"})`);
		});
		const onData = (chunk: Buffer | string) => this.consume(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);

		await this.waitForReady();
	}

	/** stop the child and drop the process-exit hook (also used on failures) */
	stop(): void {
		if (this.exitHook) {
			process.removeListener("exit", this.exitHook);
			this.exitHook = null;
		}
		const child = this.child;
		this.child = null;
		if (child && child.exitCode === null) {
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		}
		this.url = "";
		this.connected = false;
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
					return finish(new Error(this.lastError || "tunnel: cloudflared exited before publishing a route"));
				}
				if (this.cfg.mode === "quick" && this.url) return finish();
				if (this.cfg.mode === "named" && this.connected) return finish();
				if (Date.now() >= deadline) {
					// named tunnels may still be handshaking: leave it running
					if (this.cfg.mode === "named" && this.child) return finish();
					return finish(new Error("tunnel: timed out waiting for cloudflared to publish the route"));
				}
			}, POLL_MS);
		});
	}

	private consume(chunk: string): void {
		for (const raw of chunk.split("\n")) {
			let line = raw.trim();
			if (line.length === 0) continue;
			if (line.length > MAX_LINE_CHARS) line = line.slice(0, MAX_LINE_CHARS);
			line = this.redact(line);
			this.note(line);
			if (this.cfg.mode === "quick" && !this.url) {
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
		if (t && t.length >= 6 && line.includes(t)) return line.split(t).join("[redacted]");
		return line;
	}

	status(): TunnelStatus {
		const running = this.child !== null && this.child.exitCode === null;
		const url = this.cfg.mode === "quick" ? this.url : this.cfg.hostname ?? "";
		return {
			mode: this.cfg.mode,
			running,
			connected: this.connected,
			url: running ? url : "",
			service: this.cfg.service,
			uptime_sec: running ? Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000)) : 0,
			error: this.lastError || undefined,
			recent: this.recent.slice(-5),
		};
	}
}

function fn(
	name: string,
	description: string,
	parameters: Record<string, unknown>,
	execute: (args: Record<string, unknown>) => Promise<unknown>,
): AgentFunction {
	return { name, description, parameters, execute, dangerous: false };
}

/** live runtime, set by init(); feeds tunnel_status and the startup note */
let runtime: TunnelRuntime | null = null;

export const Tunnel: Addon = {
	name: "tunnel",
	description: "Publishes the dashboard (or another local service) through a Cloudflare Tunnel with a public HTTPS route",
	functions: [], // built in init() (needs config)
	init: async (config: AppConfig) => {
		const cfg = getConfig(config);
		// named mode without a token: the registry reports "not configured"
		if (cfg.mode === "named" && !cfg.token) return false;
		const next = new TunnelRuntime(cfg);
		try {
			await next.start();
		} catch (err) {
			next.stop();
			throw err;
		}
		runtime = next;
		Tunnel.functions = [
			fn(
				"tunnel_status",
				"Get the state of the Cloudflare Tunnel that publishes the local service: public URL, uptime, last errors.",
				{ type: "object", properties: {} },
				async () => runtime?.status() ?? { error: "tunnel not running" },
			),
		];
		return true;
	},
	/** printed by the registry at startup: the public URL lands in the log */
	startupNote: () => {
		const s = runtime?.status();
		if (!s || !s.running) return undefined;
		if (s.mode === "quick") return `tunnel published ${s.url} (quick, forwarding to ${s.service})`;
		const host = s.url.length > 0 ? s.url : "set in the Cloudflare dashboard";
		return `tunnel started (named, forwarding to ${s.service}, hostname: ${host})`;
	},
};
