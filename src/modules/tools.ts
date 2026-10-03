// Tool registry: discovers .tl tools, validates their headers and args,
// and executes them with the interpreter sandbox + a hard timeout.

import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { parseToolSource, executeToolSource, validateToolArgs, ParseError } from "../utils/toolang/index.js";
import { resolveLimits } from "../utils/toolang/limits.js";
import { ToolContext, LoadedTool, ModuleError } from "./types.js";
import { AppConfig } from "../utils/config.js";

export class ToolRegistry {
	private tools = new Map<string, LoadedTool>();
	/** runtime overrides set from the dashboard (win over config at runtime) */
	private runtimeDisabled = new Set<string>();
	/** extra top-level TooLang vars injected into every tool run (addon modules) */
	private extraVars: Record<string, unknown> = {};
	/** enable the gated `env` module inside tools (skills.allow_env_access) */
	private envAccess = false;

	constructor(private config: AppConfig) {}

	/** Inject addon modules / env access. Call before loadAll(). */
	setContext(opts: { extraVars?: Record<string, unknown>; envAccess?: boolean }): void {
		if (opts.extraVars) this.extraVars = opts.extraVars;
		if (opts.envAccess !== undefined) this.envAccess = opts.envAccess;
	}

	/** Scan all configured tool directories. Previously loaded tools are replaced. */
	loadAll(): { loaded: string[]; skipped: string[] } {
		const loaded: string[] = [];
		const skipped: string[] = [];
		for (const dir of this.config.tools.directories) {
			const abs = path.resolve(dir);
			if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
			for (const entry of readdirSync(abs)) {
				if (!entry.endsWith(".tl")) continue;
				const name = entry.slice(0, -3);
				if (this.config.tools.disabled.includes(name)) {
					skipped.push(name);
					continue;
				}
				try {
					const tool = this.loadOne(path.join(abs, entry));
					this.tools.set(tool.name, tool);
					loaded.push(tool.name);
				} catch (err) {
					// a broken tool file shouldn't kill the whole bot
					skipped.push(name);
					console.warn(`[tools] skipped '${entry}': ${(err as Error).message}`);
				}
			}
		}
		return { loaded, skipped };
	}

	private loadOne(filePath: string): LoadedTool {
		const source = readFileSync(filePath, "utf-8");
		const { header } = parseToolSource(source);
		if (!header.name || !/^[a-z][a-z0-9_]{1,63}$/.test(header.name)) {
			throw new ModuleError(`invalid tool name '${header.name}' (lowercase letters, digits, underscores, max 64 chars)`);
		}
		const config = this.config;
		return {
			name: header.name,
			description: header.description ?? "",
			path: filePath,
			header,
			invoke: async (args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> => {
				const errors = validateToolArgs(header, args);
				if (errors.length > 0) throw new ModuleError(`invalid arguments for tool '${header.name}': ${errors.join("; ")}`);

				const limits = resolveLimits({
					maxLoopIterations: config.agent.toolang.maxLoopIterations,
					maxCallDepth: config.agent.toolang.maxCallDepth,
					maxSteps: config.agent.toolang.maxSteps,
					maxOutputLength: config.agent.toolang.maxOutputLength,
				});

				const result = await executeToolSource(source, args, {
					config: {
						http: config.agent.toolang.http,
						fs: config.agent.toolang.fs,
						node: config.agent.toolang.node,
						docker: {
							enabled: config.docker.enabled,
							host: config.docker.host,
							allowedPorts: config.docker.allowedPorts,
							disallowedImages: config.docker.disallowedImages,
							allowedImages: config.docker.allowedImages,
							defaultImage: config.docker.defaultImage,
						},
					},
					discord: ctx.discord as never,
					agent: ctx.agent as never,
					extraVars: this.extraVars,
					envAccess: this.envAccess,
					limits,
				});

				if (!result.success) throw new ModuleError(`tool '${header.name}' failed: ${result.error}`);
				return result.data;
			},
		};
	}

	get(name: string): LoadedTool | undefined {
		return this.tools.get(name);
	}

	/** True when the tool is loaded AND not disabled (config or runtime). */
	isEnabled(name: string): boolean {
		if (!this.tools.has(name)) return false;
		if (this.runtimeDisabled.has(name)) return false;
		if (this.config.tools.disabled.includes(name)) return false;
		return true;
	}

	/** Runtime toggle. Returns the new state; no-op for unknown tools. */
	setEnabled(name: string, enabled: boolean): boolean | null {
		if (!this.tools.has(name)) return null;
		if (enabled) this.runtimeDisabled.delete(name);
		else this.runtimeDisabled.add(name);
		return this.isEnabled(name);
	}

	/** Names disabled at runtime only (dashboard toggles). */
	runtimeDisabledNames(): string[] {
		return [...this.runtimeDisabled];
	}

	has(name: string): boolean {
		return this.isEnabled(name);
	}

	names(): string[] {
		return [...this.tools.keys()];
	}

	all(): LoadedTool[] {
		return [...this.tools.values()];
	}

	count(): number {
		return this.tools.size;
	}

	/** Loaded + enabled right now. */
	enabledAll(): LoadedTool[] {
		return this.all().filter((t) => this.isEnabled(t.name));
	}

	/** Build LLM tool definitions for enabled tools only. */
	toToolDefs(): { name: string; description: string; arguments: unknown[] }[] {
		return this.enabledAll().map((t) => ({ name: t.name, description: t.description, arguments: t.header.arguments }));
	}
}

/** Run a registered tool with the timeout from config. */
export async function runTool(registry: ToolRegistry, name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
	if (!registry.isEnabled(name)) throw new ModuleError(`tool '${name}' is disabled`);
	const tool = registry.get(name);
	if (!tool) throw new ModuleError(`unknown tool '${name}'`);
	const timeoutMs = ctx.config.agent.toolang.toolTimeoutMs;
	return await Promise.race([
		tool.invoke(args, ctx),
		new Promise((_resolve, reject) => setTimeout(() => reject(new ModuleError(`tool '${name}' timed out after ${timeoutMs}ms`)), timeoutMs)),
	]);
}

export { ParseError };
