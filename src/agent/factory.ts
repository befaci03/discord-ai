// Agent factory: builds the right agent implementation from config
// [agent.providers] and [agent.models]. Returns null when no provider is
// usable so the bot can degrade gracefully.

import DB from "../db/struct.js";
import Agent, { Model, ModelType, Provider, Tool } from "./struct.js";
import OpenAIAgent from "./openai.js";
import AnthropicAgent from "./anthropic.js";
import { brainTools } from "./brainfns.js";
import { AppConfig } from "../utils/config.js";
import { Logger } from "../utils/logger.js";
import { AgentFunction, ToolContext } from "../modules/types.js";
import { ToolRegistry, runTool } from "../modules/tools.js";
import { ToolDef } from "../utils/llmproto/types.js";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Wrap addon capabilities as LLM-callable tools.
 * Dangerous (mutating) calls are audit-logged: actor, function, repo/recipient
 * target, never argument bodies (they may contain user content at scale).
 * `guard` (optional) is checked at CALL time so runtime-disabled addons are
 * refused immediately, even though the tool list was built at startup.
 */
export function addonFunctionsToTools(
	functions: AgentFunction[],
	audit?: (name: string, target: string) => void | Promise<void>,
	guard?: (fnName: string) => boolean,
): Tool[] {
	return functions.map((f) => ({
		name: f.name,
		description: f.description + (f.dangerous ? " (mutates external state)" : ""),
		parameters: f.parameters,
		invoker: async (args: Record<string, unknown>) => {
			if (guard && !guard(f.name)) throw new Error(`addon function '${f.name}' is disabled`);
			if (f.dangerous && audit) await audit(f.name, String(args.repo ?? args.place ?? args.to ?? ""));
			return await f.execute(args);
		},
	}));
}

/** True when a provider has a real key (unexpanded ${VAR} refs don't count). */
function providerUsable(providers: AppConfig["agent"]["providers"], name: string | undefined): boolean {
	if (!name) return false;
	const pcfg = providers[name];
	return !!pcfg?.api_key && !pcfg.api_key.startsWith("${");
}

/**
 * Can chat actually run? Mirrors buildAgent's startup checks so the dashboard
 * reports the truth instead of "configured" for an empty providers table.
 */
export function llmAvailable(config: AppConfig): boolean {
	const modelsCfg = config.agent.models;
	if (!modelsCfg?.default_model?.provider) return false;
	if (!String(modelsCfg.default_model.model ?? "").trim()) return false;
	return providerUsable(config.agent.providers, modelsCfg.default_model.provider);
}

/** Cap for the optional .prompt.txt persona, so a stray file can't bloat every request. */
const PROMPT_FILE_CAP = 8000;

/**
 * Optional extra persona in .prompt.txt (project root). Added on top of
 * [agent].prompt: think of it as "how you talk", config as "what you are".
 */
function loadPromptFile(log: Logger): string {
	const file = path.join(process.cwd(), ".prompt.txt");
	try {
		if (!existsSync(file)) return "";
		const text = readFileSync(file, "utf-8").trim();
		if (text.length === 0) return "";
		if (text.length > PROMPT_FILE_CAP) log.warn(`.prompt.txt is ${text.length} chars, truncated to ${PROMPT_FILE_CAP}`);
		return text.slice(0, PROMPT_FILE_CAP);
	} catch (err) {
		log.warn(`could not read .prompt.txt: ${(err as Error).message}`);
		return "";
	}
}

/** Header args (string/number/boolean + disallow list) -> JSON schema. */
function argsToSchema(args: ToolDef["arguments"]): Record<string, unknown> {
	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	for (const a of args) {
		const prop: Record<string, unknown> = { type: a.type, description: a.description };
		if (a.disallow && a.disallow.length > 0) {
			prop.description = `${a.description} (refused values: ${a.disallow.join(", ")})`;
		}
		properties[a.name] = prop;
		required.push(a.name); // the .tl validator requires every header arg
	}
	return { type: "object", properties, required };
}

/**
 * Expose the loaded TooLang tools to the LLM. Runtime state is NOT baked in:
 * `agent.toolFilter` (index.ts) decides per ask, so a dashboard toggle hides or
 * shows the tool immediately, both in the prompt and in the schema. Calls are
 * re-checked anyway by runTool. Every run is recorded like the `!toolname`
 * path does, with `agent` as the actor.
 *
 * docker tools are dropped while `[docker].enabled = false`: offering four
 * tools that can only answer "docker is disabled" is noise, the config page
 * and the docs already say docker is off.
 */
export function registryToAgentTools(registry: ToolRegistry, ctx: ToolContext, db: DB): Tool[] {
	const dockerEnabled = ctx.config.docker.enabled === true;
	return registry
		.all()
		.filter((t) => dockerEnabled || !t.name.startsWith("docker_"))
		.map((t) => ({
		name: t.name,
		description: t.description,
		parameters: argsToSchema(t.header.arguments),
		invoker: async (args: Record<string, unknown>) => {
			const started = Date.now();
			try {
				const result = await runTool(registry, t.name, args, ctx);
				await record(db, t.name, 1, "", Date.now() - started, "tool.run");
				return result;
			} catch (err) {
				// bookkeeping must never mask the real tool error
				await record(db, t.name, 0, err instanceof Error ? err.message : "unknown", Date.now() - started, "tool.fail");
				throw err;
			}
		},
		}));
}

/** Persist one tool run + an audit entry; swallows DB hiccups on purpose. */
async function record(db: DB, tool: string, success: 0 | 1, error: string, durationMs: number, action: "tool.run" | "tool.fail"): Promise<void> {
	try {
		await db.recordToolRun({ tool, caller_id: "agent", success, error: error.slice(0, 200), duration_ms: durationMs });
		await db.audit({ actor_id: "agent", action, target: tool, details: "{}" });
	} catch {
		/* metrics only: never break the tool call over a failed write */
	}
}

const MODEL_TYPE_KEYS: { key: string; type: ModelType }[] = [
	{ key: "coding_model", type: "coding" },
	{ key: "image_model", type: "image" },
	{ key: "video_model", type: "video" },
	{ key: "tts_model", type: "tts" },
	{ key: "stt_model", type: "stt" },
];

export function buildAgent(db: DB, config: AppConfig, tools: Tool[], log: Logger): Agent | null {
	const providers = config.agent.providers ?? {};
	const modelsCfg = config.agent.models;
	if (!modelsCfg?.default_model?.provider) {
		log.warn("[agent.models].default_model is not configured, LLM chat disabled");
		return null;
	}

	const providerName = modelsCfg.default_model.provider;
	if (!providerUsable(providers, providerName)) {
		// key still an unexpanded ${VAR}, or the provider section is missing
		log.warn(`provider '${providerName}' has no API key (set the env var or config key), LLM chat disabled`);
		return null;
	}
	const modelName = String(modelsCfg.default_model.model ?? "").trim();
	if (!modelName) {
		log.warn("[agent.models].default_model.model is empty, LLM chat disabled");
		return null;
	}
	const pcfg = providers[providerName];
	const provider: Provider = {
		apiType: pcfg.api_type === 0 ? 0 : 1,
		baseUrl: pcfg.base_url ?? "",
		apiKey: pcfg.api_key,
	};

	const mkModel = (type: ModelType, name: string, prov: Provider = provider): Model => ({ type, provider: prov, name });
	const models: Model[] = [mkModel("default", modelName)];

	if (!modelsCfg.use_same_models) {
		// per-type model lists. Missing/disabled/unconfigured types fall back
		// to the default model instead of throwing at call time, but a
		// misconfigured entry (unknown provider, empty name) is reported once
		// at startup so the user can fix the config.
		for (const { key, type } of MODEL_TYPE_KEYS) {
			const list = modelsCfg[key as keyof typeof modelsCfg] as { enabled: boolean; provider: string; model: string }[] | undefined;
			const entry = list?.find((m) => m?.enabled && String(m.model ?? "").trim());
			if (!entry) continue; // no configured model for this type: stays on the default
			if (!providerUsable(providers, entry.provider)) {
				log.warn(`model type '${type}': provider '${entry.provider}' has no API key, falling back to the default model`);
				continue;
			}
			const pcfg2 = providers[entry.provider];
			models.push(mkModel(type, String(entry.model).trim(), {
				apiType: pcfg2.api_type === 0 ? 0 : 1,
				baseUrl: pcfg2.base_url ?? "",
				apiKey: pcfg2.api_key,
			}));
		}
	}

	const missing = MODEL_TYPE_KEYS.map((m) => m.type).filter((t) => !models.some((m) => m.type === t));
	if (missing.length > 0) log.info(`model types without a dedicated model (fall back to '${modelName}'): ${missing.join(", ")}`);

	const log2 = log.child("agent");
	const extraPersona = loadPromptFile(log2);
	const sysPrompt = `${config.agent.prompt}${extraPersona ? `\n${extraPersona}` : ""}\nYour name is ${config.agent.name}.`;
	const agent = provider.apiType === 0
		? new AnthropicAgent(db, provider, models, sysPrompt, tools, 4, log2)
		: new OpenAIAgent(db, provider, models, sysPrompt, tools, 4, log2);
	// the brain reads its shape from [agent.brain]: memory window, seed tastes,
	// seeded people profiles, and the one-shot reset flag
	agent.maxMemory = config.agent.brain.memory;
	agent.seed = config.agent.brain;
	agent.reseed = config.agent.brain.reset;
	// personality tools belong to this instance: bind them now that it exists
	tools.push(...brainTools(agent));
	return agent;
}
