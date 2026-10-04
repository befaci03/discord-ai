// Dashboard API handlers. Read-only endpoints + one carefully guarded
// tool-run endpoint. No secrets ever reach the responses.

import { IncomingMessage } from "node:http";
import * as os from "node:os";
import { AppConfig } from "../utils/config.js";
import DB from "../db/struct.js";
import { ToolRegistry, runTool } from "../modules/tools.js";
import { SkillRegistry } from "../modules/skills.js";
import { AddonRegistry, availableAddons } from "../modules/addons.js";
import { ToolContext } from "../modules/types.js";
import { llmAvailable } from "../agent/factory.js";
import { AgentStatus } from "../agent/struct.js";
import { LiveBus } from "./live.js";

export interface DashboardDeps {
	config: AppConfig;
	db: DB;
	tools: ToolRegistry;
	skills: SkillRegistry;
	addons: AddonRegistry;
	log: (level: "info" | "warn" | "error", message: string) => void;
	/** discord client once connected, for presence/guild info */
	client?: unknown;
	/** live agent status (busy/doing/mode) once the agent is built */
	agentState?: () => AgentStatus | undefined;
	/** live event bus, optional in tests */
	live?: LiveBus;
	/** called after a successful toggle, so runtime state can be persisted */
	onToggle?: (kind: "tool" | "skill" | "addon", name: string, enabled: boolean) => void;
}

export interface ApiResult {
	status: number;
	body: unknown;
}

const MAX_BODY_BYTES = 48_000;

export function readApiBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

/**
 * Handle POST /api/{tools,skills,addons}/toggle.
 * Body: { name: string, enabled: boolean }. Runtime overrides are persisted to
 * modules/config.json (so they survive restarts) and audited + broadcast live.
 */
async function handleToggle(
	deps: DashboardDeps,
	req: IncomingMessage,
	kind: "tool" | "skill" | "addon",
): Promise<ApiResult> {
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(await readApiBody(req) || "{}") as Record<string, unknown>;
	} catch {
		return { status: 400, body: { error: "invalid JSON body" } };
	}
	const name = String(body.name ?? "").trim();
	const enabled = body.enabled === true;
	if (!/^[a-z][a-z0-9_]{1,63}$/.test(name)) return { status: 400, body: { error: "invalid name" } };

	const registry = kind === "tool" ? deps.tools : kind === "skill" ? deps.skills : deps.addons;
	const newState = registry.setEnabled(name, enabled);
	if (newState === null) return { status: 404, body: { error: `unknown ${kind} '${name}'` } };

	deps.onToggle?.(kind, name, enabled);
	await deps.db.audit({ actor_id: "dashboard", action: `${kind}.${enabled ? "enable" : "disable"}`, target: name, details: "{}" });
	deps.live?.emit({ kind: "audit", action: `${kind} ${enabled ? "enabled" : "disabled"}`, actor: "dashboard", target: name });
	deps.log(enabled ? "info" : "warn", `${kind} '${name}' ${enabled ? "enabled" : "disabled"} via dashboard`);
	return { status: 200, body: { ok: true, name, enabled: newState } };
}

/** Convert inline `key=value` args + a JSON body into tool args. */
function coerceArgs(raw: Record<string, unknown>, argDefs: { name: string; type: string }[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const def of argDefs) {
		const v = raw[def.name];
		if (v === undefined) continue;
		if (def.type === "number") {
			const n = Number(v);
			if (!Number.isNaN(n)) out[def.name] = n;
		} else if (def.type === "boolean") {
			out[def.name] = v === true || v === "true" || v === "1";
		} else {
			out[def.name] = String(v);
		}
	}
	return out;
}

/** One tool run's payload sent to the browser: capped, never a flood. */
const MAX_RUN_BYTES = 200_000;

function capResult(result: unknown): unknown {
	let json = "";
	try {
		json = JSON.stringify(result) ?? String(result);
	} catch {
		return { unserializable: true };
	}
	if (json.length <= MAX_RUN_BYTES) return result;
	return { truncated: true, bytes: json.length, preview: json.slice(0, 2_000) };
}

export function systemInfo() {
	const mem = { total: os.totalmem(), free: os.freemem() };
	// Bun reports a Node-compatible process.version; show the real runtime
	const bunVer = (process.versions as Record<string, string | undefined>).bun;
	return {
		platform: `${os.platform()} ${os.arch()}`,
		runtime: bunVer ? `bun ${bunVer} (node compat ${process.version})` : `node ${process.version}`,
		uptimeSec: Math.floor(process.uptime()),
		memUsedPct: Math.round(((mem.total - mem.free) / mem.total) * 100),
		memTotalMb: Math.round(mem.total / 1024 / 1024),
		load1m: Math.round(os.loadavg()[0] * 100) / 100,
	};
}

export async function handleApi(req: IncomingMessage, deps: DashboardDeps, path: string, method: string): Promise<ApiResult> {
	const { db, tools, skills, addons, config, live } = deps;

	if (method !== "GET" && method !== "POST") return { status: 405, body: { error: "method not allowed" } };

	switch (path) {
		case "/api/health":
			return { status: 200, body: { ok: true, uptimeSec: Math.floor(process.uptime()) } };

		case "/api/status": {
			const client = deps.client as { user?: { tag?: string }; guilds?: { cache: { size: number } } } | undefined;
			return {
				status: 200,
				body: {
					tools: tools.count(),
					skills: skills.count(),
					addons: addons.count(),
					enabled_addons: config.addons.enabled,
					known_addons: availableAddons(),
					health: systemInfo(),
					agent: {
						name: config.agent.name,
						llm: llmAvailable(config) ? "configured" : "off",
						...(deps.agentState?.() ?? {}),
					},
					bot: {
						online: !!client?.user,
						user: client?.user?.tag ?? null,
						guilds: client?.guilds?.cache?.size ?? 0,
						status_text: config.bot.status,
					},
				},
			};
		}

		case "/api/tools":
			return {
				status: 200,
				body: tools.all().map((t) => ({
					name: t.name,
					description: t.description,
					args: t.header.arguments,
					enabled: tools.isEnabled(t.name),
				})),
			};

		case "/api/skills":
			return {
				status: 200,
				body: skills.all().map((s) => ({
					name: s.name,
					description: s.description,
					triggers: s.triggers,
					priority: s.priority,
					enabled: skills.isEnabled(s.name),
				})),
			};

		case "/api/addons":
			return { status: 200, body: addons.status() };

		case "/api/stats": {
			const bodies = await Promise.all(
				tools.all().map(async (t) => ({ tool: t.name, ...(await db.toolStats(t.name) ?? { runs: 0, failures: 0, avgMs: 0 }) })),
			);
			return { status: 200, body: bodies };
		}

		case "/api/audit":
			return { status: 200, body: await db.recentAudit(50) };

		case "/api/tools/toggle": {
			if (method !== "POST") return { status: 405, body: { error: "use POST" } };
			return await handleToggle(deps, req, "tool");
		}

		case "/api/skills/toggle": {
			if (method !== "POST") return { status: 405, body: { error: "use POST" } };
			return await handleToggle(deps, req, "skill");
		}

		case "/api/addons/toggle": {
			if (method !== "POST") return { status: 405, body: { error: "use POST" } };
			return await handleToggle(deps, req, "addon");
		}

		case "/api/run": {
			if (method !== "POST") return { status: 405, body: { error: "use POST" } };
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(await readApiBody(req) || "{}") as Record<string, unknown>;
			} catch {
				return { status: 400, body: { error: "invalid JSON body" } };
			}
			const name = String(body.tool ?? "");
			const tool = tools.get(name);
			if (!tool) return { status: 404, body: { error: `unknown tool '${name.slice(0, 64)}'` } };

			const args = coerceArgs((body.args ?? {}) as Record<string, unknown>, tool.header.arguments);
			const ctx: ToolContext = {
				config,
				discord: deps.client,
				log: deps.log,
			};
			const started = Date.now();
			try {
				const result = await runTool(tools, name, args, ctx);
				const ms = Date.now() - started;
				await db.recordToolRun({ tool: name, caller_id: "dashboard", success: 1, error: "", duration_ms: ms });
				await db.audit({ actor_id: "dashboard", action: "tool.run", target: name, details: "{}" });
				live?.emit({ kind: "tool.run", tool: name, caller: "dashboard", ok: true, ms });
				return { status: 200, body: { ok: true, data: capResult(result) } };
			} catch (err) {
				const ms = Date.now() - started;
				await db.recordToolRun({ tool: name, caller_id: "dashboard", success: 0, error: (err as Error).message.slice(0, 200), duration_ms: ms });
				await db.audit({ actor_id: "dashboard", action: "tool.fail", target: name, details: "{}" });
				live?.emit({ kind: "tool.run", tool: name, caller: "dashboard", ok: false, ms, error: (err as Error).message.slice(0, 120) });
				// capped like every other error we hand out: a tool error can be huge
				return { status: 200, body: { ok: false, error: (err as Error).message.slice(0, 2000) } };
			}
		}

		default:
			return { status: 404, body: { error: "not found" } };
	}
}
