// Shared types for the tools/skills module system

import { ToolDef } from "../utils/llmproto/types.js";
import { AppConfig } from "../utils/config.js";

export interface ToolContext {
	/** discord client, may be absent if the bot isn't connected yet */
	discord?: unknown;
	/** the agent, may be absent in dry runs */
	agent?: unknown;
	config: AppConfig;
	/** per-invocation logger */
	log: (level: "info" | "warn" | "error", message: string) => void;
}

export interface LoadedTool {
	name: string;
	description: string;
	/** absolute path of the .tl file */
	path: string;
	header: ToolDef;
	/** run the tool with validated args */
	invoke: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export interface SkillExample {
	description: string;
	code: string;
}

export interface LoadedSkill {
	name: string;
	description: string;
	/** absolute path of the skill file */
	path: string;
	/** trigger phrases / patterns that should activate this skill */
	triggers: string[];
	/** markdown instructions injected into the agent's context when the skill is active */
	instructions: string;
	/** tools the skill recommends, by name */
	tools: string[];
	/** optional .tl snippets shown to the agent as usage examples */
	examples: SkillExample[];
	/** skill priority: higher wins when multiple skills match (default 0) */
	priority: number;
	/** skill enabled? */
	enabled: boolean;
}

export class ModuleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModuleError";
	}
}

/**
 * A function the LLM agent itself can call (via the provider's tool calling).
 * This is how addons extend the agent: each capability becomes a function the
 * model sees and can invoke during a conversation.
 */
export interface AgentFunction {
	/** function name as the LLM sees it, e.g. "github_create_issue" */
	name: string;
	description: string;
	/** JSON schema for the parameters object */
	parameters: Record<string, unknown>;
	/** run the function; throw to surface an error to the model */
	execute: (args: Record<string, unknown>) => Promise<unknown>;
	/** true for anything that mutates external state (issues, stars, posts...) */
	dangerous?: boolean;
}

/**
 * An addon extends the AGENT with new capabilities (AgentFunctions) and can
 * also expose TooLang modules to tool scripts. Selected via addons.enabled.
 */
export interface Addon {
	/** unique slug used in addons.enabled, e.g. "github" */
	name: string;
	/** human description shown in the dashboard */
	description: string;
	/** capabilities added to the agent itself */
	functions: AgentFunction[];
	/** optional TooLang top-level variables, e.g. { github: {...} } */
	modules?: Record<string, unknown>;
	/** called once at registration. Return false to skip (e.g. missing token). */
	init?: (config: AppConfig) => boolean | Promise<boolean>;
	/** optional one-line summary the registry logs right after init succeeds */
	startupNote?: () => string | undefined;
}

export interface AddonStatus {
	name: string;
	description: string;
	functions: string[];
	configured: boolean;
	/** false when disabled at runtime from the dashboard (functions are refused) */
	enabled?: boolean;
	error?: string;
}
