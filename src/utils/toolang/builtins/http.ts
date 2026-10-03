/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// Core builtins: http (SSRF-guarded), json, Array, Object

import { RuntimeError } from "../evaluator.js";
import { isHostAllowed, type HttpPolicy } from "../netguard.js";

function httpPolicy(cfg?: Record<string, unknown>): HttpPolicy {
	if (!cfg || typeof cfg.http !== "object" || cfg.http === null) return {};
	const raw = cfg.http as Record<string, unknown>;
	return {
		allowedHosts: Array.isArray(raw.allowedHosts) ? raw.allowedHosts.map(String) : undefined,
		blockedHosts: Array.isArray(raw.blockedHosts) ? raw.blockedHosts.map(String) : undefined,
		blockPrivate: raw.blockPrivate === true,
		maxResponseBytes: typeof raw.maxResponseBytes === "number" ? raw.maxResponseBytes : 2_000_000,
		timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : 15_000,
		allowedMethods: Array.isArray(raw.allowedMethods) ? raw.allowedMethods.map(String) : undefined,
	};
}

async function httpRequest(policy: HttpPolicy, method: string, url: string, body?: unknown): Promise<{ status: number; response: string; headers: Record<string, string> }> {
	let parsed: URL;
	try {
		parsed = new URL(String(url));
	} catch {
		throw new RuntimeError(`http.${method.toLowerCase()}: invalid url '${String(url).slice(0, 100)}'`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new RuntimeError(`http.${method.toLowerCase()}: only http(s) protocols are allowed`);
	}
	if (!isHostAllowed(parsed.hostname, policy)) {
		throw new RuntimeError(`http.${method.toLowerCase()}: host '${parsed.hostname}' is not allowed by policy`);
	}
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), policy.timeoutMs ?? 15_000);
		const resp = await fetch(parsed, {
			method,
			signal: controller.signal,
			redirect: "error", // no silent redirects: a redirect could bypass the host policy
			headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		clearTimeout(timer);
		const text = await resp.text();
		if (text.length > (policy.maxResponseBytes ?? 2_000_000)) {
			throw new RuntimeError(`http.${method.toLowerCase()}: response too large (${text.length} bytes)`);
		}
		const headers: Record<string, string> = {};
		resp.headers.forEach((v, k) => headers[k] = v);
		return { status: resp.status, response: text, headers }
	} catch (err) {
		throw new RuntimeError(`HTTP ${method} failed: ${(err as Error).message}`)
	}
}

export function HTTP(cfg?: Record<string, unknown>): Record<string, Function> {
	const policy = httpPolicy(cfg);
	const guard = (method: string) => {
		if (policy.allowedMethods && policy.allowedMethods.length > 0 && !policy.allowedMethods.includes(method)) {
			throw new RuntimeError(`http method ${method} is not allowed by policy`);
		}
	};
	return {
		get: async (url: string) => { guard("GET"); return httpRequest(policy, "GET", url) },
		post: async (url: string, body?: unknown) => { guard("POST"); return httpRequest(policy, "POST", url, body) },
		put: async (url: string, body?: unknown) => { guard("PUT"); return httpRequest(policy, "PUT", url, body) },
		patch: async (url: string, body?: unknown) => { guard("PATCH"); return httpRequest(policy, "PATCH", url, body) },
		delete: async (url: string) => { guard("DELETE"); return httpRequest(policy, "DELETE", url) },
		head: async (url: string) => { guard("HEAD"); return httpRequest(policy, "HEAD", url) },
		options: async (url: string) => { guard("OPTIONS"); return httpRequest(policy, "OPTIONS", url) }
	}
}

export function json(): Record<string, Function> {
	return {
		to: (text: string) => {
			try { return JSON.parse(text) }
			catch { throw new RuntimeError(`json.to failed to parse: ${String(text).slice(0, 100)}`) }
		},
		from: (obj: unknown) => JSON.stringify(obj)
	}
}

export function array(): Record<string, Function> {
	return {
		slice: (arr: unknown[], start: number, end?: number) => {
			if (!Array.isArray(arr)) throw new RuntimeError("Array.slice expects an array");
			return arr.slice(start, end);
		},
		push: (arr: unknown[], item: unknown) => {
			if (!Array.isArray(arr)) throw new RuntimeError("Array.push expects an array");
			return [...arr, item];
		},
		length: (arr: unknown[]) => {
			if (!Array.isArray(arr)) throw new RuntimeError("Array.length expects an array");
			return arr.length;
		},
		range: (start: number, end?: number, step?: number) => {
			const s = end === undefined ? 0 : Number(start);
			const e = end === undefined ? Number(start) : Number(end);
			const st = step === undefined ? 1 : Number(step);
			if (st === 0) throw new RuntimeError("Array.range step cannot be 0");
			const out: number[] = [];
			if (st > 0) for (let i = s; i < e; i += st) out.push(i);
			else for (let i = s; i > e; i += st) out.push(i);
			return out;
		},
		repeat: (item: unknown, count: number) => {
			const n = Number(count);
			if (n < 0 || n > 100_000) throw new RuntimeError("Array.repeat count out of bounds");
			return Array.from({ length: n }, () => item);
		}
	}
}

export function object(): Record<string, Function> {
	return {
		keys: (obj: unknown) => {
			if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new RuntimeError("Object.keys expects an object");
			return Object.keys(obj);
		},
		values: (obj: unknown) => {
			if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new RuntimeError("Object.values expects an object");
			return Object.values(obj);
		},
		entries: (obj: unknown) => {
			if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new RuntimeError("Object.entries expects an object");
			return Object.entries(obj);
		},
		fromEntries: (arr: unknown) => {
			if (!Array.isArray(arr)) throw new RuntimeError("Object.fromEntries expects an array of [key, value] pairs");
			return Object.fromEntries(arr as [string, unknown][]);
		},
		merge: (a: unknown, b: unknown) => {
			if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) {
				throw new RuntimeError("Object.merge expects two objects");
			}
			return { ...(a as Record<string, unknown>), ...(b as Record<string, unknown>) };
		},
		freeze: (obj: unknown) => {
			if (!obj || typeof obj !== "object") throw new RuntimeError("Object.freeze expects an object");
			return Object.freeze(obj);
		}
	}
}
