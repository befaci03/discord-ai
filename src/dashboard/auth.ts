// Dashboard authentication: passcode -> session cookie.
// - passcode stored as scrypt hash with salt (never in plaintext at runtime)
// - sessions are secure-random tokens, server-side, revocable, expiry-based
// - login endpoint limited to 3 attempts/min/IP (brute force guard), with a
//   progressive lockout after repeated failures
// - all comparisons timing-safe, tokens only ever compared via hmac digest

import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const MAX_SESSIONS = 50; // drop oldest when exceeded
const COOKIE_NAME = "dash_session";

// ---------- passcode ----------

export function hashPasscode(passcode: string): string {
	const salt = randomBytes(16);
	const key = scryptSync(passcode, salt, 32, { N: 16384, r: 8, p: 1 });
	return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPasscode(passcode: string, stored: string): boolean {
	try {
		const [scheme, saltB64, keyB64] = stored.split("$");
		if (scheme !== "scrypt" || !saltB64 || !keyB64) return false;
		const salt = Buffer.from(saltB64, "base64");
		const expected = Buffer.from(keyB64, "base64");
		const actual = scryptSync(passcode, salt, expected.length, { N: 16384, r: 8, p: 1 });
		return timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}

// ---------- sessions ----------

interface Session {
	tokenHash: string; // hmac-sha256 of the raw token, so a DB/log leak can't replay
	expires: number;
	ip: string;
	created: number;
}

// server-side pepper from env; falls back to a per-process random (sessions
// then just don't survive restarts, which is fine). Computed ONCE per process:
// re-rolling per call would make verification impossible.
const TOKEN_PEPPER = process.env.DASHBOARD_SECRET || randomBytes(32).toString("hex");

function hashToken(token: string): string {
	return createHmac("sha256", TOKEN_PEPPER).update(token).digest("hex");
}

export class SessionStore {
	private sessions = new Map<string, Session>(); // keyed by tokenHash

	create(ip: string): string {
		// 256-bit token from CSPRNG
		const token = randomBytes(32).toString("base64url");
		this.sessions.set(hashToken(token), { tokenHash: "", expires: Date.now() + SESSION_TTL_MS, ip, created: Date.now() });
		// store the hash as the key; drop expired/oldest if over budget
		this.prune();
		return token;
	}

	private prune(): void {
		const now = Date.now();
		for (const [k, s] of this.sessions) {
			if (s.expires < now) this.sessions.delete(k);
		}
		while (this.sessions.size > MAX_SESSIONS) {
			const oldest = [...this.sessions.entries()].sort((a, b) => a[1].created - b[1].created)[0];
			if (!oldest) break;
			this.sessions.delete(oldest[0]);
		}
	}

	/** Valid token -> true. Expired sessions are removed on sight. */
	verify(token: string): boolean {
		if (typeof token !== "string" || token.length === 0 || token.length > 128) return false;
		const h = hashToken(token);
		const s = this.sessions.get(h);
		if (!s) return false;
		if (s.expires < Date.now()) {
			this.sessions.delete(h);
			return false;
		}
		// sliding expiry
		s.expires = Date.now() + SESSION_TTL_MS;
		return true;
	}

	revoke(token: string): void {
		this.sessions.delete(hashToken(token));
	}

	revokeAll(): void {
		this.sessions.clear();
	}

	count(): number {
		this.prune();
		return this.sessions.size;
	}

	/** Non-reversible info for the dashboard: count + age of newest session. */
	stats(): { sessions: number; oldestAgeSec: number | null } {
		this.prune();
		let oldest: number | null = null;
		for (const s of this.sessions.values()) {
			if (oldest === null || s.created < oldest) oldest = s.created;
		}
		return { sessions: this.sessions.size, oldestAgeSec: oldest === null ? null : Math.floor((Date.now() - oldest) / 1000) };
	}
}

// ---------- login rate limiting (brute force) ----------

interface LoginBucket {
	/** timestamps of attempts in the current minute window */
	attempts: number[];
	/** locked until this timestamp */
	lockedUntil: number;
	/** consecutive failures since last success */
	failures: number;
}

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 3;
const LOCKOUT_BASE_MS = 5 * 60_000;
const LOCKOUT_MAX_MS = 60 * 60_000;

export class LoginLimiter {
	private buckets = new Map<string, LoginBucket>();

	private bucket(ip: string): LoginBucket {
		let b = this.buckets.get(ip);
		if (!b) {
			b = { attempts: [], lockedUntil: 0, failures: 0 };
			this.buckets.set(ip, b);
		}
		return b;
	}

	/** true if the IP may attempt a login right now */
	check(ip: string): { allowed: boolean; retryAfterSec: number } {
		const b = this.bucket(ip);
		const now = Date.now();
		if (b.lockedUntil > now) {
			return { allowed: false, retryAfterSec: Math.ceil((b.lockedUntil - now) / 1000) };
		}
		b.attempts = b.attempts.filter((t) => now - t < WINDOW_MS);
		if (b.attempts.length >= MAX_PER_WINDOW) {
			return { allowed: false, retryAfterSec: Math.ceil((WINDOW_MS - (now - b.attempts[0])) / 1000) };
		}
		return { allowed: true, retryAfterSec: 0 };
	}

	/** Record an attempt. success resets failures; failures escalate lockout. */
	record(ip: string, success: boolean): void {
		const b = this.bucket(ip);
		const now = Date.now();
		b.attempts.push(now);
		b.attempts = b.attempts.filter((t) => now - t < WINDOW_MS);
		if (success) {
			b.failures = 0;
			b.lockedUntil = 0;
			return;
		}
		b.failures++;
		if (b.failures >= MAX_PER_WINDOW) {
			// exponential-ish: 5min, 10min, 20min ... capped at 1h
			const lockMs = Math.min(LOCKOUT_BASE_MS * 2 ** (b.failures - MAX_PER_WINDOW), LOCKOUT_MAX_MS);
			b.lockedUntil = now + lockMs;
		}
	}

	stats(): { trackedIps: number; lockedIps: number } {
		const now = Date.now();
		let locked = 0;
		for (const b of this.buckets.values()) if (b.lockedUntil > now) locked++;
		return { trackedIps: this.buckets.size, lockedIps: locked };
	}
}

// ---------- cookie helpers ----------

export function sessionCookie(token: string): string {
	return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearCookie(): string {
	return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export function tokenFromRequest(req: IncomingMessage): string | null {
	const header = req.headers.cookie;
	if (!header) return null;
	for (const part of header.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (k === COOKIE_NAME) return rest.join("=");
	}
	return null;
}

// Special URLs the WS layer or login flow may hit without a session.
export const PUBLIC_PATHS = new Set(["/api/login", "/api/health"]);
