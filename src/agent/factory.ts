// Agent factory: builds the right agent implementation from config
// [agent.providers] and [agent.models]. Returns null when no provider is
// usable so the bot can degrade gracefully.

import DB from "../db/struct.js";
import Agent, { Model, ModelType, Provider, Tool } from "./struct.js";
import OpenAIAgent from "./openai.js";
import AnthropicAgent from "./anthropic.js";
import { AppConfig } from "../utils/config.js";
import { Logger } from "../utils/logger.js";
import { AgentFunction } from "../modules/types.js";

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

	const sysPrompt = `${config.agent.prompt}\nYour name is ${config.agent.name}.`;
	const log2 = log.child("agent");
	if (provider.apiType === 0) {
		return new AnthropicAgent(db, provider, models, sysPrompt, tools, 4, log2);
	}
	return new OpenAIAgent(db, provider, models, sysPrompt, tools, 4, log2);
}
