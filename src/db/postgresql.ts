// PostgreSQL backend. Documents the exact schema the other backends mirror:
//   users(id, username, trust, notes, created_at, updated_at)
//   audit(actor_id, action, target, details, created_at)
//   tool_runs(tool, caller_id, success, error, duration_ms, created_at)
//   kv(ns, key, value, updated_at)
//   chats(author_id, username, guild_id, content, response, created_at)
//
// BIGINT columns are parsed as JS numbers with pg-types (pg returns strings
// for int8 by default), so created_at etc. are numeric everywhere.

import { Pool, types } from "pg";
import DB, { UserRow, AuditRow, ToolRunRow, ChatRow, ToolRunListener, AuditListener } from "./struct.js";
import {
	MAX_ID, MAX_USERNAME, MAX_GUILD_ID, MAX_TARGET, MAX_ACTION,
	MAX_CONTENT, MAX_KV, MAX_KV_KEY, MAX_KV_NS, MAX_TOOL, MAX_CALLER, MAX_ERROR, MAX_DETAILS,
} from "./constants.js";

// number everywhere: pg returns int8 as a string by default
types.setTypeParser(20, (v) => parseInt(v as string, 10));

export default class PostgreSQLDB implements DB {
	private pool: Pool;
	private onToolRun: ToolRunListener | null = null;
	private onAudit: AuditListener | null = null;

	constructor(opts: { host: string; port: number; user: string; password: string; database: string }) {
		this.pool = new Pool({
			host: opts.host,
			port: opts.port,
			user: opts.user,
			password: opts.password,
			database: opts.database,
			max: 5,
			connectionTimeoutMillis: 5_000,
			idleTimeoutMillis: 10_000,
		});
	}

	async init(): Promise<void> {
		await this.pool.query(`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			username TEXT NOT NULL,
			trust INTEGER NOT NULL DEFAULT 0,
			notes TEXT NOT NULL DEFAULT '',
			created_at BIGINT NOT NULL,
			updated_at BIGINT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS audit (
			id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
			actor_id TEXT NOT NULL,
			action TEXT NOT NULL,
			target TEXT NOT NULL,
			details TEXT NOT NULL DEFAULT '{}',
			created_at BIGINT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS tool_runs (
			id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
			tool TEXT NOT NULL,
			caller_id TEXT NOT NULL,
			success INTEGER NOT NULL,
			error TEXT NOT NULL DEFAULT '',
			duration_ms INTEGER NOT NULL,
			created_at BIGINT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS kv (
			ns TEXT NOT NULL,
			key TEXT NOT NULL,
			value TEXT NOT NULL,
			updated_at BIGINT NOT NULL,
			PRIMARY KEY (ns, key)
		);
		CREATE TABLE IF NOT EXISTS chats (
			author_id TEXT NOT NULL,
			username TEXT NOT NULL,
			guild_id TEXT NOT NULL DEFAULT '',
			content TEXT NOT NULL,
			response TEXT NOT NULL DEFAULT '',
			created_at BIGINT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_audit_created ON audit(created_at);
		CREATE INDEX IF NOT EXISTS idx_tool_runs_tool ON tool_runs(tool, created_at);
		CREATE INDEX IF NOT EXISTS idx_chats_author ON chats(author_id, created_at);
		CREATE INDEX IF NOT EXISTS idx_chats_created ON chats(created_at);
	`);
	}

	async close(): Promise<void> {
		// drain the pool: graceful; any in-flight queries finish on their own
		await this.pool.end();
	}

	setOnToolRun(fn: ToolRunListener): void {
		this.onToolRun = fn;
	}
	setOnAudit(fn: AuditListener): void {
		this.onAudit = fn;
	}

	async getUser(id: string): Promise<UserRow | undefined> {
		const rows = await this.pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
		return rows.rows[0];
	}

	async upsertUser(user: Pick<UserRow, "id" | "username"> & { trust?: number; notes?: string }): Promise<void> {
		const now = Date.now();
		await this.pool.query(
			`INSERT INTO users (id, username, trust, notes, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $5)
			ON CONFLICT(id) DO UPDATE SET
				username = excluded.username,
				trust = excluded.trust,
				notes = excluded.notes,
				updated_at = excluded.updated_at`,
			[user.id, user.username, user.trust ?? 0, (user.notes ?? "").slice(0, MAX_ID), now],
		);
	}

	async audit(entry: Omit<AuditRow, "id" | "created_at">): Promise<void> {
		const created = Date.now();
		await this.pool.query(
			"INSERT INTO audit (actor_id, action, target, details, created_at) VALUES ($1, $2, $3, $4, $5)",
			[entry.actor_id.slice(0, MAX_TARGET), entry.action.slice(0, MAX_ACTION), entry.target.slice(0, MAX_TARGET), entry.details.slice(0, MAX_DETAILS), created],
		);
		try {
			this.onAudit?.({ ...entry, id: undefined, created_at: created } as AuditRow);
		} catch {
			/* listeners must not break writes */
		}
	}

	async recentAudit(limit: number): Promise<AuditRow[]> {
		const rows = await this.pool.query<AuditRow>("SELECT * FROM audit ORDER BY created_at DESC LIMIT $1", [Math.min(Math.max(limit, 1), 500)]);
		return rows.rows;
	}

	async pruneAudit(beforeMs: number): Promise<number> {
		const res = await this.pool.query("DELETE FROM audit WHERE created_at < $1", [beforeMs]);
		return (res as { rowCount?: number }).rowCount ?? 0;
	}

	async recordToolRun(entry: Omit<ToolRunRow, "id" | "created_at">): Promise<void> {
		const created = Date.now();
		await this.pool.query(
			"INSERT INTO tool_runs (tool, caller_id, success, error, duration_ms, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
			[entry.tool.slice(0, MAX_TOOL), entry.caller_id.slice(0, MAX_CALLER), entry.success ? 1 : 0, entry.error.slice(0, MAX_ERROR), entry.duration_ms, created],
		);
		try {
			this.onToolRun?.({ ...entry, id: undefined, created_at: created } as ToolRunRow);
		} catch {
			/* listeners must not break writes */
		}
	}

	async toolStats(tool: string): Promise<{ runs: number; failures: number; avgMs: number } | undefined> {
		const rows = await this.pool.query<{ runs: number; failures: number | null; avgMs: number | null }>(
			"SELECT COUNT(*) AS runs, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures, AVG(duration_ms) AS avgMs FROM tool_runs WHERE tool = $1",
			[tool],
		);
		const row = rows.rows[0];
		if (!row || row.runs === 0) return undefined;
		return { runs: row.runs, failures: row.failures ?? 0, avgMs: row.avgMs ?? 0 };
	}

	async pruneToolRuns(beforeMs: number): Promise<number> {
		const res = await this.pool.query("DELETE FROM tool_runs WHERE created_at < $1", [beforeMs]);
		return (res as { rowCount?: number }).rowCount ?? 0;
	}

	async kvGet(ns: string, key: string): Promise<string | undefined> {
		const rows = await this.pool.query<{ value: string }>("SELECT value FROM kv WHERE ns = $1 AND key = $2", [ns.slice(0, MAX_KV_NS), key.slice(0, MAX_KV_KEY)]);
		return rows.rows[0]?.value;
	}

	async kvSet(ns: string, key: string, value: string): Promise<void> {
		await this.pool.query(
			`INSERT INTO kv (ns, key, value, updated_at) VALUES ($1, $2, $3, $4)
			ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			[ns.slice(0, MAX_KV_NS), key.slice(0, MAX_KV_KEY), value.slice(0, MAX_KV), Date.now()],
		);
	}

	async kvDelete(ns: string, key: string): Promise<void> {
		await this.pool.query("DELETE FROM kv WHERE ns = $1 AND key = $2", [ns.slice(0, MAX_KV_NS), key.slice(0, MAX_KV_KEY)]);
	}

	async recordChat(entry: Omit<ChatRow, "id" | "created_at">): Promise<void> {
		await this.pool.query(
			"INSERT INTO chats (author_id, username, guild_id, content, response, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
			[entry.author_id.slice(0, MAX_ID), entry.username.slice(0, MAX_USERNAME), entry.guild_id.slice(0, MAX_GUILD_ID), entry.content.slice(0, MAX_CONTENT), entry.response.slice(0, MAX_CONTENT), Date.now()],
		);
	}

	async recentChats(limit: number): Promise<ChatRow[]> {
		const rows = await this.pool.query<ChatRow>("SELECT * FROM chats ORDER BY created_at DESC LIMIT $1", [Math.min(Math.max(limit, 1), 500)]);
		return rows.rows;
	}

	async chatsByUser(authorId: string, limit: number): Promise<ChatRow[]> {
		const rows = await this.pool.query<ChatRow>("SELECT * FROM chats WHERE author_id = $1 ORDER BY created_at DESC LIMIT $2", [authorId, Math.min(Math.max(limit, 1), 500)]);
		return rows.rows;
	}
}
