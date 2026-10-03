// Config loading, validation and defaults.
// config.toml is the user-facing file; every key has a sane default so a
// minimal config still boots. Secrets can come from env vars via ${VAR} syntax.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import toml from "toml";

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
export interface AppConfig {
	bot: BotConfig;
	http: HttpConfig;
	docker: DockerConfig;
	database: DatabaseConfig;
	agent: AgentConfig;
	addons: { enabled: string[] } & Record<string, unknown>;
	tools: { directories: string[]; disabled: string[] };
	skills: { directories: string[]; disabled: string[]; allowEnvAccess: boolean };
	logging: { level: "debug" | "info" | "warn" | "error"; file?: string };
}

const DEFAULT_CONFIG: AppConfig = {
	bot: { token: "", client_id: "", status: "watching the server burn" },
	http: { host: "127.0.0.1", port: 3000, allowedIps: ["127.0.0.1"], passcode_env: "DASHBOARD_PASSCODE" },
	database: {
		use: "sqlite",
		sqlite: { path: "modules/data.sqlite" },
		postgres: { host: "127.0.0.1", port: 5432, username: "", password: "", database: "discord_ai" },
		mariadb: { host: "127.0.0.1", port: 3306, username: "", password: "", database: "discord_ai" },
		mongodb: { uri: "mongodb://127.0.0.1:27017", database: "discord_ai" },
		cassandra: { contact_points: ["127.0.0.1"], local_datacenter: "datacenter1", keyspace: "discord_ai" },
	},
	docker: {
		enabled: false,
		host: "unix:///var/run/docker.sock",
		allowedPorts: ["3456-35665"],
		maxContainers: 100,
		disallowedImages: ["ftp", "ssh", "windows"],
		defaultImage: "debian:bookworm",
	},
	agent: {
		name: "Agent",
		prompt: "You are a helpful Discord agent.",
		brain: { memory: 30, likes: [], dislikes: [], favorites: [], pending: [], people: {}, reset: false },
		providers: {},
		models: {
			use_same_models: true,
			default_model: { provider: "openai", model: "gpt-4o-mini" },
			coding_model: [], image_model: [], video_model: [], tts_model: [], stt_model: [], rerank_model: [],
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
			fs: { root: "./sandbox", maxFileSize: 1_000_000, allowWrite: false },
			node: { enabled: false, timeoutMs: 30_000 },
		},
	},
	addons: { enabled: [] },
	tools: { directories: ["modules/tools"], disabled: [] },
	skills: { directories: ["modules/skills"], disabled: [], allowEnvAccess: false },
	logging: { level: "info" },
};

/**
 * Map a snake_case config key onto its camelCase counterpart when the defaults
 * tree spells it that way. example.config.toml uses snake_case for readability
 * (`allowed_ips`, `max_loop_iterations`); without this those keys landed as
 * unknown extras and the documented setting was silently ignored.
 * Keys that already exist (e.g. `passcode_env`, `guild_id`) keep their name.
 */
function normalizeKey(key: string, defaults: Record<string, unknown>): string {
	if (key in defaults || !key.includes("_")) return key;
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
		if (def && typeof def === "object" && !Array.isArray(def) && typeof value === "object" && !Array.isArray(value)) {
			out[key] = deepFill(value as Record<string, unknown>, def as Record<string, unknown>);
		} else {
			out[key] = value;
		}
	}
	return out;
}

/** Expand ${ENV_VAR} references from the environment. */
function expandEnv(value: unknown): unknown {
	if (typeof value === "string") {
		return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name: string) => {
			const env = process.env[name];
			if (env === undefined) return match; // leave as-is so missing vars are visible
			return env;
		});
	}
	if (Array.isArray(value)) return value.map(expandEnv);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v);
		return out;
	}
	return value;
}

/** Bounded list of trimmed strings; accepts a comma-separated string too. */
function normStringList(value: unknown, cap: number): string[] {
	const list = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
	return list.map(String).map((s) => s.trim().slice(0, 120)).filter(Boolean).slice(0, cap);
}

function requireNonEmpty(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`config: '${path}' must be a non-empty string`);
	return value;
}

function validateConfig(cfg: AppConfig): void {
	// http port sanity
	cfg.http.port = Math.min(Math.max(Math.floor(Number(cfg.http.port) || 3000), 1), 65535);

	// brain: bounded memory + normalized taste lists (this feeds the system prompt,
	// so caps apply even though the file is operator-controlled)
	const b = cfg.agent.brain;
	const mem = Number(b.memory);
	b.memory = Number.isFinite(mem) ? Math.min(Math.max(Math.floor(mem), 0), 200) : 30;
	for (const key of ["likes", "dislikes", "favorites", "pending"] as const) {
		b[key] = normStringList(b[key], 50);
	}
	b.reset = b.reset === true;
	if (typeof b.people !== "object" || b.people === null || Array.isArray(b.people)) b.people = {};
	b.people = Object.fromEntries(
		Object.entries(b.people)
			.slice(0, 50)
			.map(([id, p]) => {
				const person = (p ?? {}) as BrainPersonConfig;
				return [id, {
					description: String(person.description ?? "").slice(0, 500),
					likes: normStringList(person.likes, 25),
					dislikes: normStringList(person.dislikes, 25),
					personalities: normStringList(person.personalities, 25),
				} satisfies BrainPersonConfig];
			}),
	);

	// toolang limits get clamped, never trusted raw
	const t = cfg.agent.toolang;
	t.maxLoopIterations = Math.min(Math.max(Math.floor(Number(t.maxLoopIterations) || 10_000), 10), 1_000_000);
	t.maxCallDepth = Math.min(Math.max(Math.floor(Number(t.maxCallDepth) || 64), 2), 512);
	t.maxSteps = Math.min(Math.max(Math.floor(Number(t.maxSteps) || 200_000), 100), 10_000_000);
	t.maxOutputLength = Math.min(Math.max(Math.floor(Number(t.maxOutputLength) || 100_000), 100), 5_000_000);
	t.toolTimeoutMs = Math.min(Math.max(Math.floor(Number(t.toolTimeoutMs) || 30_000), 1000), 600_000);
	t.fs.root = path.resolve(t.fs.root);
	t.fs.maxFileSize = Math.min(Math.max(Math.floor(Number(t.fs.maxFileSize) || 1_000_000), 100), 50_000_000);

	// docker ports must look like ranges
	if (!Array.isArray(cfg.docker.allowedPorts)) cfg.docker.allowedPorts = [];
	cfg.docker.allowedPorts = cfg.docker.allowedPorts.map(String).filter((r) => /^\d+-\d+$|^\d+$/.test(r));

	// bot credentials come from env in production; config values must be literal
	if (process.env.DISCORD_TOKEN) cfg.bot.token = process.env.DISCORD_TOKEN;
	if (process.env.DISCORD_CLIENT_ID) cfg.bot.client_id = process.env.DISCORD_CLIENT_ID;

	// dashboard passcode: passcode_env wins, then passcode, else disabled auth
	// (an empty/missing passcode hash means the dashboard only allows login via
	// loopback + explicitly generated session; we handle that in index.ts)
	if (cfg.http.passcode_env && process.env[cfg.http.passcode_env]) {
		cfg.http.passcode = process.env[cfg.http.passcode_env];
	}

	// addons: enabled must be a list of known-shaped slugs; other keys under
	// [addons.*] are addon-specific settings (token strings etc.)
	if (!Array.isArray(cfg.addons.enabled)) cfg.addons.enabled = [];
	cfg.addons.enabled = cfg.addons.enabled.map(String).map((s) => s.toLowerCase());
	// never let addon settings hold expanded secrets in logs: keys are lowercase slugs
	for (const key of Object.keys(cfg.addons)) {
		if (key === "enabled") continue;
		if (!/^[a-z][a-z0-9_]*$/.test(key)) delete cfg.addons[key];
	}

	// database: pick the driver + sanity-check its settings
	if (!cfg.database || typeof cfg.database.use !== "string") cfg.database.use = "sqlite";
	cfg.database.use = cfg.database.use.toLowerCase();
	if (cfg.database.use !== "sqlite" && cfg.database.use !== "postgres" && cfg.database.use !== "mariadb" && cfg.database.use !== "mongodb" && cfg.database.use !== "cassandra") {
		console.warn(`[database] unknown driver '${cfg.database.use}', defaulting to sqlite`);
		cfg.database.use = "sqlite";
	}
	if (cfg.database.postgres?.port) cfg.database.postgres.port = Math.min(Math.max(Math.floor(Number(cfg.database.postgres.port) || 5432), 1), 65535);
	if (cfg.database.mariadb?.port) cfg.database.mariadb.port = Math.min(Math.max(Math.floor(Number(cfg.database.mariadb.port) || 3306), 1), 65535);

	// providers: env expansion for api keys
	for (const provider of Object.values(cfg.agent.providers)) {
		if (provider && typeof provider === "object" && typeof provider.api_key === "string") {
			provider.api_key = provider.api_key.replace(/\$\{([A-Z0-9_]+)\}/g, (m, name: string) => process.env[name] ?? m);
		}
	}
}

let cached: AppConfig | null = null;

export function loadConfig(configPath?: string): AppConfig {
	if (cached) return cached;
	const resolved = path.resolve(configPath ?? path.join(process.cwd(), "config.toml"));
	if (!existsSync(resolved)) {
		// no config: write the example so the user has a starting point
		const example = path.resolve(path.join(process.cwd(), "example.config.toml"));
		if (existsSync(example)) {
			mkdirSync(path.dirname(resolved), { recursive: true });
			writeFileSync(resolved, readFileSync(example, "utf-8"));
			console.warn(`[config] no config found, created '${resolved}' from example.config.toml. Edit it and restart.`);
		} else {
			console.warn("[config] no config file found, running with defaults (bot will not be able to connect)");
		}
	}
	let parsed: Record<string, unknown> = {};
	if (existsSync(resolved)) {
		try {
			parsed = toml.parse(readFileSync(resolved, "utf-8")) as unknown as Record<string, unknown>;
		} catch (err) {
			throw new Error(`config: failed to parse '${resolved}': ${(err as Error).message}`);
		}
	}
	parsed = expandEnv(parsed) as Record<string, unknown>;
	const merged = deepFill(parsed, DEFAULT_CONFIG as unknown as Record<string, unknown>) as unknown as AppConfig;
	validateConfig(merged);
	cached = merged;
	return merged;
}

/** Test helper: drop the cached config so the next loadConfig() re-reads. */
export function resetConfigCache(): void {
	cached = null;
}
