// Config loading, validation and defaults.
// config.toml is the user-facing file; every key has a sane default so a
// minimal config still boots. Secrets can come from env vars via ${VAR} syntax.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import toml from 'toml';
import { DEFAULT_ERROR_TEMPLATES, type ErrorTemplates } from './errors.js';
import { validateConfig } from './config.validate.js';

export interface HttpConfig {
	host: string;
	port: number;
	allowedIps: string[];
	/** dashboard passcode (plain in config is hashed at load; prefer ${ENV} ref) */
	passcode?: string;
	/** env var name holding the passcode, takes priority over passcode */
	passcode_env?: string;
}

export interface DockerConfig {
	enabled: boolean;
	host: string;
	allowedPorts: string[];
	maxContainers: number;
	disallowedImages: string[];
	allowedImages?: string[];
	defaultImage: string;
	/** host paths the llm may bind-mount (resolved at load; empty = none) */
	allowedVolumePaths: string[];
	/** interface published ports bind to; default loopback = this box only */
	bindAddress: string;
}

export interface ToolangConfig {
	maxLoopIterations: number;
	maxCallDepth: number;
	maxSteps: number;
	maxOutputLength: number;
	toolTimeoutMs: number;
	allowToolCreation: boolean;
	allowSkillCreation: boolean;
	http: {
		allowedHosts?: string[];
		blockedHosts?: string[];
		blockPrivate: boolean;
		allowedMethods?: string[];
		maxResponseBytes: number;
		timeoutMs: number;
	};
	fs: {
		root: string;
		maxFileSize: number;
		allowWrite: boolean;
	};
	node: {
		enabled: boolean;
		allowedCommands?: string[];
		deniedCommands?: string[];
		timeoutMs: number;
	};
	// docker policy lives in the top level [docker] section (single source of truth)
}

export interface AgentProviderConfig {
	api_type: 0 | 1; // 1 is openai-compatible, 0 is anthropic-compatible
	base_url: string;
	api_key: string;
}

export interface AgentModelsConfig {
	use_same_models: boolean;
	default_model: { provider: string; model: string };
	coding_model: { enabled: boolean; provider: string; model: string }[];
	image_model: { enabled: boolean; provider: string; model: string }[];
	video_model: { enabled: boolean; provider: string; model: string }[];
	tts_model: { enabled: boolean; provider: string; model: string }[];
	stt_model: { enabled: boolean; provider: string; model: string }[];
	rerank_model: { enabled: boolean; provider: string; model: string }[];
}

/** One seeded person profile ([agent.brain.people].<id>). */
export interface BrainPersonConfig {
	description?: string;
	likes?: string[];
	dislikes?: string[];
	personalities?: string[];
}

/**
 * The agent's brain: how much it remembers and what it starts out liking.
 * The seed below only applies while nothing is saved yet, unless `reset` is set,
 * which wipes the saved state once so the config takes over again.
 */
export interface BrainConfig {
	/** conversation turns the agent remembers (rolling window; 0 = no memory) */
	memory: number;
	likes: string[];
	dislikes: string[];
	favorites: string[];
	/** things it wants to get better at */
	pending: string[];
	/** people it already knows, keyed by numeric Discord user id */
	people: Record<string, BrainPersonConfig>;
	/** true = forget saved brain state at startup and re-seed from this section */
	reset: boolean;
}

export interface AgentConfig {
	name: string;
	prompt: string;
	/** char budget for the optional .prompt.txt persona (clamped 1k..120k) */
	promptFileMaxChars: number;
	/** tool-call rounds per ask before the model is forced to answer (1..64) */
	toolRounds: number;
	/** output tokens per provider call; 0 = provider default */
	maxTokens: number;
	brain: BrainConfig;
	providers: Record<string, AgentProviderConfig>;
	models: AgentModelsConfig;
	toolang: ToolangConfig;
}

export interface SqiteDatabaseConfig {
	path: string;
}

export interface PostgresDatabaseConfig {
	host: string;
	port: number;
	username: string;
	password: string;
	database: string;
}

export interface MariadbDatabaseConfig {
	host: string;
	port: number;
	username: string;
	password: string;
	database: string;
}

export interface MongodbDatabaseConfig {
	uri: string;
	database: string;
}

export interface CassandraDatabaseConfig {
	contact_points: string[];
	local_datacenter: string;
	keyspace: string;
}

export interface DatabaseConfig {
	use: string;
	sqlite: SqiteDatabaseConfig;
	postgres: PostgresDatabaseConfig;
	mariadb: MariadbDatabaseConfig;
	mongodb: MongodbDatabaseConfig;
	cassandra: CassandraDatabaseConfig;
}

export interface BotConfig {
	token: string;
	client_id: string;
	guild_id?: string;
	status: string;
}

/** Housekeeping knobs that do not belong to any one section. */
export interface GeneralConfig {
	/**
	 * Message the bot posts in the channel while the agent works through tool
	 * calls. `[TOOL_NAME]` is replaced with the tool(s) being called, the same
	 * message is edited on every following call and deleted before the final
	 * reply. Empty string = never post it.
	 */
	execution_message: string;
	/**
	 * Wording for the failures the bot shows in chat: generic fallback,
	 * failed tool calls, third-party outages, missing provider. See
	 * ErrorTemplates in errors.ts for the placeholders ({error}, {service}).
	 */
	errors: ErrorTemplates;
}
export interface AppConfig {
	bot: BotConfig;
	general: GeneralConfig;
	http: HttpConfig;
	docker: DockerConfig;
	database: DatabaseConfig;
	agent: AgentConfig;
	addons: { enabled: string[] } & Record<string, unknown>;
	tools: { directories: string[]; disabled: string[] };
	skills: { directories: string[]; disabled: string[]; allowEnvAccess: boolean };
	logging: { level: 'debug' | 'info' | 'warn' | 'error'; file?: string };
}

const DEFAULT_CONFIG: AppConfig = {
	bot: { token: '', client_id: '', status: 'watching the server burn' },
	general: {
		execution_message: ':thinking: *Executing `[TOOL_NAME]`...*',
		errors: { ...DEFAULT_ERROR_TEMPLATES }
	},
	http: { host: '127.0.0.1', port: 3000, allowedIps: ['127.0.0.1'], passcode_env: 'DASHBOARD_PASSCODE' },
	database: {
		use: 'sqlite',
		sqlite: { path: 'modules/data.sqlite' },
		postgres: { host: '127.0.0.1', port: 5432, username: '', password: '', database: 'discord_ai' },
		mariadb: { host: '127.0.0.1', port: 3306, username: '', password: '', database: 'discord_ai' },
		mongodb: { uri: 'mongodb://127.0.0.1:27017', database: 'discord_ai' },
		cassandra: { contact_points: ['127.0.0.1'], local_datacenter: 'datacenter1', keyspace: 'discord_ai' }
	},
	docker: {
		enabled: false,
		host: 'unix:///var/run/docker.sock',
		allowedPorts: ['3456-35665'],
		maxContainers: 100,
		disallowedImages: ['ftp', 'ssh', 'windows'],
		defaultImage: 'debian:bookworm',
		allowedVolumePaths: [],
		bindAddress: '127.0.0.1'
	},
	agent: {
		name: 'Agent',
		prompt: 'You are a helpful Discord agent.',
		promptFileMaxChars: 24_000,
		toolRounds: 16,
		maxTokens: 0,
		brain: { memory: 30, likes: [], dislikes: [], favorites: [], pending: [], people: {}, reset: false },
		providers: {},
		models: {
			use_same_models: true,
			default_model: { provider: 'openai', model: 'gpt-4o-mini' },
			coding_model: [],
			image_model: [],
			video_model: [],
			tts_model: [],
			stt_model: [],
			rerank_model: []
		},
		toolang: {
			maxLoopIterations: 10_000,
			maxCallDepth: 64,
			maxSteps: 200_000,
			maxOutputLength: 100_000,
			toolTimeoutMs: 30_000,
			allowToolCreation: false,
			allowSkillCreation: false,
			http: { blockPrivate: true, maxResponseBytes: 2_000_000, timeoutMs: 15_000 },
			fs: { root: './sandbox', maxFileSize: 1_000_000, allowWrite: false },
			node: { enabled: false, timeoutMs: 30_000 }
		}
	},
	addons: { enabled: [] },
	tools: { directories: ['modules/tools'], disabled: [] },
	skills: { directories: ['modules/skills'], disabled: [], allowEnvAccess: false },
	logging: { level: 'info' }
};

/**
 * Map a snake_case config key onto its camelCase counterpart when the defaults
 * tree spells it that way. example.config.toml uses snake_case for readability
 * (`allowed_ips`, `max_loop_iterations`); without this those keys landed as
 * unknown extras and the documented setting was silently ignored.
 * Keys that already exist (e.g. `passcode_env`, `guild_id`) keep their name.
 */
function normalizeKey(key: string, defaults: Record<string, unknown>): string {
	if (key in defaults || !key.includes('_')) return key;
	const camel = key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
	return camel in defaults ? camel : key;
}

/** Recursively fill missing keys in `target` from `defaults`. */
function deepFill(target: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...defaults };
	for (const [rawKey, value] of Object.entries(target)) {
		if (value === undefined) continue;
		const key = normalizeKey(rawKey, out);
		const def = out[key];
		if (def && typeof def === 'object' && !Array.isArray(def) && typeof value === 'object' && !Array.isArray(value)) {
			out[key] = deepFill(value as Record<string, unknown>, def as Record<string, unknown>);
		} else {
			out[key] = value;
		}
	}
	return out;
}

/** Expand ${ENV_VAR} references from the environment. */
function expandEnv(value: unknown): unknown {
	if (typeof value === 'string') {
		return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name: string) => {
			const env = process.env[name];
			if (env === undefined) return match; // leave as-is so missing vars are visible
			return env;
		});
	}
	if (Array.isArray(value)) return value.map(expandEnv);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v);
		return out;
	}
	return value;
}

let cached: AppConfig | null = null;

export function loadConfig(configPath?: string): AppConfig {
	if (cached) return cached;
	const resolved = path.resolve(configPath ?? path.join(process.cwd(), 'config.toml'));
	if (!existsSync(resolved)) {
		// no config: write the example so the user has a starting point
		const example = path.resolve(path.join(process.cwd(), 'example.config.toml'));
		if (existsSync(example)) {
			mkdirSync(path.dirname(resolved), { recursive: true });
			writeFileSync(resolved, readFileSync(example, 'utf-8'));
			console.warn(`[config] no config found, created '${resolved}' from example.config.toml. Edit it and restart.`);
		} else {
			console.warn('[config] no config file found, running with defaults (bot will not be able to connect)');
		}
	}
	let parsed: Record<string, unknown> = {};
	if (existsSync(resolved)) {
		try {
			parsed = toml.parse(readFileSync(resolved, 'utf-8')) as unknown as Record<string, unknown>;
		} catch (err) {
			throw new Error(`config: failed to parse '${resolved}': ${(err as Error).message}`);
		}
	}
	parsed = expandEnv(parsed) as Record<string, unknown>;
	const merged = deepFill(parsed, DEFAULT_CONFIG as unknown as Record<string, unknown>) as unknown as AppConfig;
	validateConfig(merged, DEFAULT_CONFIG);
	cached = merged;
	return merged;
}

/** Test helper: drop the cached config so the next loadConfig() re-reads. */
export function resetConfigCache(): void {
	cached = null;
}
