// Dashboard HTTP server: minimal Node http, no framework.
// Security: IP allowlist, global per-IP token bucket, passcode auth with
// 3-attempts/min/IP brute-force guard + progressive lockout, strict headers,
// JSON-only API, no secrets in any response. Live updates over a hand-rolled
// WebSocket hub (JSON protocol, authenticated with the session cookie).

import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { Socket } from "node:net";
import { AppConfig } from "../utils/config.js";
import { Logger } from "../utils/logger.js";
import { DashboardDeps, handleApi, readApiBody } from "./handlers.js";
import { renderDashboard } from "./page.js";
import { hashPasscode, verifyPasscode, SessionStore, LoginLimiter, sessionCookie, clearCookie, tokenFromRequest, PUBLIC_PATHS } from "./auth.js";
import { WsHub } from "./ws.js";
import { LiveBus } from "./live.js";

function ipAllowed(req: IncomingMessage, allowed: string[]): string | null {
	// behind a proxy we only trust the socket address unless 'proxy' is in the list
	const socketIp = req.socket.remoteAddress ?? "";
	const normalized = socketIp.replace(/^::ffff:/, "");
	if (allowed.includes("proxy")) {
		const fwd = (req.headers["x-forwarded-for"] ?? "").toString().split(",")[0].trim();
		if (fwd && allowed.includes(fwd)) return fwd;
	}
	if (allowed.includes(normalized)) return normalized;
	// ::1 is 127.0.0.1 in ipv6 clothes
	if (allowed.includes("127.0.0.1") && normalized === "::1") return normalized;
	return null;
}

/** global token bucket: refill 1 token/sec, bucket 60 (generic flood guard) */
const buckets = new Map<string, { tokens: number; last: number }>();
function rateLimited(ip: string): boolean {
	const now = Date.now();
	const b = buckets.get(ip) ?? { tokens: 60, last: now };
	const refill = Math.floor((now - b.last) / 1000);
	b.tokens = Math.min(60, b.tokens + refill);
	b.last = now;
	if (b.tokens <= 0) return true;
	b.tokens--;
	buckets.set(ip, b);
	return false;
}

function send(res: ServerResponse, status: number, body: string, type = "application/json", extraHeaders: Record<string, string> = {}): void {
	res.writeHead(status, {
		"Content-Type": type,
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
		"Referrer-Policy": "no-referrer",
		"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'self'; connect-src 'self'",
		"Cache-Control": "no-store",
		...extraHeaders,
	});
	res.end(body);
}

function unauthorized(res: ServerResponse): void {
	send(res, 401, JSON.stringify({ error: "unauthorized" }));
}

export interface DashboardAuth {
	/** scrypt hash of the dashboard passcode */
	passcodeHash: string;
	sessions: SessionStore;
	limiter: LoginLimiter;
}

export function startDashboard(deps: DashboardDeps, config: AppConfig, log: Logger, auth: DashboardAuth, live: LiveBus): Promise<{ server: Server; hub: WsHub }> {
	return new Promise((resolve, reject) => {
	const hub = new WsHub((_ws) => {
		// new client: send a full snapshot so the page paints immediately
		handleApiSnapshot(deps, auth, (_ws.send).bind(_ws));
	});

		const server = createServer(async (req, res) => {
			const ip = ipAllowed(req, config.http.allowedIps);
			if (!ip) {
				send(res, 403, JSON.stringify({ error: "forbidden" }));
				return;
			}
			if (rateLimited(ip)) {
				send(res, 429, JSON.stringify({ error: "rate limited" }));
				return;
			}
			try {
				const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
				const path = url.pathname;

				// ----- public routes -----
				if (req.method === "GET" && (path === "/" || path === "/index.html")) {
					// the page itself is public; it shows the login box until authed
					send(res, 200, renderDashboard(), "text/html; charset=utf-8");
					return;
				}
				if (PUBLIC_PATHS.has(path) && req.method === "POST" && path === "/api/login") {
					const limiter = auth.limiter;
					const gate = limiter.check(ip);
					if (!gate.allowed) {
						log.warn(`dashboard: login rate limited from ${ip} (retry in ${gate.retryAfterSec}s)`);
						send(res, 429, JSON.stringify({ error: "too many attempts", retryAfterSec: gate.retryAfterSec }));
						return;
					}
					let passcode = "";
					try {
						const body = JSON.parse(await readApiBody(req)) as { passcode?: unknown };
						passcode = String(body.passcode ?? "");
					} catch {
						send(res, 400, JSON.stringify({ error: "invalid body" }));
						return;
					}
					if (passcode.length === 0 || passcode.length > 256) {
						limiter.record(ip, false);
						send(res, 400, JSON.stringify({ error: "invalid passcode" }));
						return;
					}
					if (!verifyPasscode(passcode, auth.passcodeHash)) {
						limiter.record(ip, false);
						live.emit({ kind: "log", level: "warn", message: `dashboard: failed login from ${ip}` });
						log.warn(`dashboard: failed login from ${ip}`);
						send(res, 401, JSON.stringify({ error: "invalid passcode" }));
						return;
					}
					limiter.record(ip, true);
					const token = auth.sessions.create(ip);
					log.info(`dashboard: login from ${ip}`);
					send(res, 200, JSON.stringify({ ok: true }), "application/json", { "Set-Cookie": sessionCookie(token) });
					return;
				}
				if (path === "/api/logout" && req.method === "POST") {
					const token = tokenFromRequest(req);
					if (token) auth.sessions.revoke(token);
					send(res, 200, JSON.stringify({ ok: true }), "application/json", { "Set-Cookie": clearCookie() });
					return;
				}
				if (path === "/api/health" && req.method === "GET") {
					// health stays public (no data beyond uptime)
					const result = await handleApi(req, deps, path, req.method);
					send(res, result.status, JSON.stringify(result.body));
					return;
				}

				// ----- authenticated routes -----
				const token = tokenFromRequest(req);
				if (!token || !auth.sessions.verify(token)) {
					unauthorized(res);
					return;
				}
				if (path.startsWith("/api/")) {
					const result = await handleApi(req, deps, path, req.method ?? "GET");
					send(res, result.status, JSON.stringify(result.body));
					return;
				}
				send(res, 404, JSON.stringify({ error: "not found" }));
			} catch (err) {
				log.warn(`dashboard error: ${err instanceof Error ? err.message : err}`);
				send(res, 500, JSON.stringify({ error: "internal error" }));
			}
		});

		// ----- websocket upgrades (must carry a valid session cookie) -----
		server.on("upgrade", (req, socket, head) => {
			void head;
			try {
				const ip = ipAllowed(req, config.http.allowedIps);
				const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
				if (!ip || url.pathname !== "/ws") {
					socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
					socket.destroy();
					return;
				}
				const token = tokenFromRequest(req);
				if (!token || !auth.sessions.verify(token)) {
					socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
					socket.destroy();
					return;
				}
				hub.upgrade(req, socket as Socket);
			} catch {
				socket.destroy();
			}
		});

		server.on("error", reject);
		server.listen(config.http.port, config.http.host, () => {
			log.info(`dashboard listening on http://${config.http.host}:${config.http.port} (allowed IPs: ${config.http.allowedIps.join(", ")}, auth: passcode)`);
			live.attachHub(hub);
			resolve({ server, hub });
		});
	});
}

/** Initial snapshot pushed right after a client connects. */
async function handleApiSnapshot(deps: DashboardDeps, auth: DashboardAuth, sendFn: (type: string, data?: unknown) => void): Promise<void> {
	try {
		const status = await handleApi({ headers: {} } as IncomingMessage, deps, "/api/status", "GET");
		sendFn("snapshot", {
			status: status.body,
			sessions: auth.sessions.stats(),
			login: auth.limiter.stats(),
		});
	} catch {
		sendFn("snapshot", { error: "snapshot unavailable" });
	}
}

export { hashPasscode };
