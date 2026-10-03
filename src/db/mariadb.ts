// MariaDB backend. Documents the exact schema the other backends mirror:
//   users(id, username, trust, notes, created_at, updated_at)
//   audit(actor_id, action, target, details, created_at)
//   tool_runs(tool, caller_id, success, error, duration_ms, created_at)
//   kv(ns, key, value, updated_at)
//   chats(author_id, username, guild_id, content, response, created_at)
//
// Tables use the same column names as SQLite/Pg so the dashboard and agent
// code read a single schema regardless of driver. The `id` column is an
// auto increment surrogate, since MariaDB's `INSERT ... ON DUPLICATE KEY`
// has no upsert-equivalent other than a heavy `ON DUPLICATE KEY UPDATE`.

import { createPool, type Pool } from "mariadb";

import DB, { UserRow, AuditRow, ToolRunRow, ChatRow, ToolRunListener, AuditListener } from "./struct.js";
import { MAX_ID, MAX_USERNAME, MAX_GUILD_ID, MAX_TARGET, MAX_ACTION, MAX_CONTENT, MAX_KV, MAX_KV_KEY, MAX_KV_NS, MAX_TOOL, MAX_CALLER, MAX_ERROR, MAX_DETAILS } from "./constants.js";

interface MariaDBConfig {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
}

export class MariaDB implements DB {
	private pool: Pool;
	private onToolRun: ToolRunListener | null = null;
	private onAudit: AuditListener | null = null;

	constructor(private config: MariaDBConfig) {
		this.pool = createPool({
			host: config.host,
			port: config.port,
			user: config.user,
			password: config.password,
			database: config.database,
			decimalAsNumber: true,
			supportBigNumbers: true,
		});
	}

	async init(): Promise<void> {
		const conn = await this.pool.getConnection();
		try {
			await conn.query(`CREATE TABLE IF NOT EXISTS users (
				id VARCHAR(255) PRIMARY KEY,
				username VARCHAR(128) NOT NULL,
				trust INTEGER NOT NULL DEFAULT 0,
				notes TEXT NOT NULL DEFAULT '',
				created_at BIGINT NOT NULL,
				updated_at BIGINT NOT NULL
			) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
			CREATE TABLE IF NOT EXISTS audit (
				id BIGINT AUTO_INCREMENT PRIMARY KEY,
				actor_id VARCHAR(255) NOT NULL,
				action VARCHAR(200) NOT NULL,
				target VARCHAR(255) NOT NULL,
				details TEXT NOT NULL DEFAULT '{}',
				created_at BIGINT NOT NULL
			) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
			CREATE TABLE IF NOT EXISTS tool_runs (
				id BIGINT AUTO_INCREMENT PRIMARY KEY,
				tool VARCHAR(128) NOT NULL,
				caller_id VARCHAR(128) NOT NULL,
				success INTEGER NOT NULL,
				error TEXT NOT NULL DEFAULT '',
				duration_ms INTEGER NOT NULL,
				created_at BIGINT NOT NULL
			) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
			CREATE TABLE IF NOT EXISTS kv (
				ns VARCHAR(64) NOT NULL,
				key VARCHAR(128) NOT NULL,
				value TEXT NOT NULL,
				updated_at BIGINT NOT NULL,
				PRIMARY KEY (ns, key)
			) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
			CREATE TABLE IF NOT EXISTS chats (
				author_id VARCHAR(255) NOT NULL,
				username VARCHAR(128) NOT NULL,
				guild_id VARCHAR(64) NOT NULL DEFAULT '',
				content TEXT NOT NULL,
				response TEXT NOT NULL DEFAULT '',
				created_at BIGINT NOT NULL
			) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
			CREATE INDEX IF NOT EXISTS idx_audit_created ON audit(created_at);
			CREATE INDEX IF NOT EXISTS idx_tool_runs_tool ON tool_runs(tool, created_at);
			CREATE INDEX IF NOT EXISTS idx_chats_author ON chats(author_id, created_at);
			CREATE INDEX IF NOT EXISTS idx_chats_created ON chats(created_at);
			`);
		} finally {
			conn.release();
		}
	}

	async close(): Promise<void> {
		await this.pool.end();
	}

	setOnToolRun(fn: ToolRunListener): void {
		this.onToolRun = fn;
	}
	setOnAudit(fn: AuditListener): void {
		this.onAudit = fn;
	}

	async recordUser(user: { id: string; username: string; guildId: string }): Promise<void> {
		const conn = await this.pool.getConnection();
		try {
			await conn.query(
				"INSERT INTO users (id, username, guild_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username), guild_id = VALUES(guild_id), updated_at = VALUES(updated_at)",
				[user.id, user.username.slice(0, MAX_USERNAME), user.guildId.slice(0, MAX_GUILD_ID), Date.now(), Date.now()],
			);
		} finally {
			conn.release();
		}
	}

	async getUser(id: string): Promise<UserRow | undefined> {
		const conn = await this.pool.getConnection();
		try {
			const rows = await conn.query<Record<string, unknown>[]>("SELECT * FROM users WHERE id = ?", [id]);
			const row = rows[0];
			if (!row) return undefined;
			return {
				id: String(row.id),
				username: String(row.username),
				trust: Number(row.trust ?? 0),
				notes: String(row.notes ?? ""),
				created_at: Number(row.created_at),
				updated_at: Number(row.updated_at),
			};
		} finally {
			conn.release();
		}
	}

	async upsertUser(user: Pick<UserRow, "id" | "username"> & { trust?: number; notes?: string }): Promise<void> {
		const conn = await this.pool.getConnection();
		try {
			await conn.query(
				"INSERT INTO users (id, username, trust, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username), trust = VALUES(trust), notes = VALUES(notes), updated_at = VALUES(updated_at)",
				[user.id, user.username, user.trust ?? 0, (user.notes ?? "").slice(0, MAX_ID), Date.now(), Date.now()],
			);
		} finally {
			conn.release();
		}
	}

	async audit(entry: Omit<AuditRow, "id" | "created_at">): Promise<void> {
		const created = Date.now();
		const conn = await this.pool.getConnection();
		try {
			await conn.query(
				"INSERT INTO audit (actor_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)",
				[entry.actor_id.slice(0, MAX_TARGET), entry.action.slice(0, MAX_ACTION), entry.target.slice(0, MAX_TARGET), entry.details.slice(0, MAX_DETAILS), created],
			);
		} finally {
			conn.release();
		}
		try {
			this.onAudit?.({ ...entry, id: undefined, created_at: created } as AuditRow);
		} catch {
			/* listeners must not break writes */
		}
	}

	async recordToolRun(entry: Omit<ToolRunRow, "id" | "created_at">): Promise<void> {
		const conn = await this.pool.getConnection();
		try {
			await conn.query(
				"INSERT INTO tool_runs (tool, caller_id, success, error, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[entry.tool.slice(0, MAX_TOOL), entry.caller_id.slice(0, MAX_CALLER), entry.success ? 1 : 0, entry.error.slice(0, MAX_ERROR), entry.duration_ms, Date.now()],
			);
		} finally {
			conn.release();
		}
		try {
			this.onToolRun?.({ ...entry, id: undefined, created_at: Date.now() } as ToolRunRow);
		} catch {
			/* listeners must not break writes */
		}
	}

	async recordChat(entry: Omit<ChatRow, "id" | "created_at">): Promise<void> {
		const conn = await this.pool.getConnection();
		try {
			await conn.query(
				"INSERT INTO chats (author_id, username, guild_id, content, response, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[entry.author_id.slice(0, MAX_ID), entry.username.slice(0, MAX_USERNAME), entry.guild_id.slice(0, MAX_GUILD_ID), entry.content.slice(0, MAX_CONTENT), entry.response.slice(0, MAX_CONTENT), Date.now()],
			);
		} finally {
			conn.release();
		}
	}

	async recentAudit(limit: number): Promise<AuditRow[]> {
		const conn = await this.pool.getConnection();
		try {
			const rows = (await conn.query<Record<string, unknown>[]>(
				"SELECT actor_id AS actor_id, action, target, details, created_at AS created_at FROM audit ORDER BY created_at DESC LIMIT ?",
				[Math.min(Math.max(limit, 1), 500)],
			));
			return rows.map((r) => ({
				actor_id: String(r.actor_id),
				action: String(r.action),
				target: String(r.target),
				details: String(r.details ?? "{}"),
				created_at: Number(r.created_at),
			}));
		} finally {
			conn.release();
		}
	}

	async pruneAudit(beforeMs: number): Promise<number> {
		const conn = await this.pool.getConnection();
		try {
			const res = await conn.query("DELETE FROM audit WHERE created_at < ?", [beforeMs]);
			return (res as { affectedRows?: number }).affectedRows ?? 0;
		} finally {
			conn.release();
		}
	}

	async toolStats(tool: string): Promise<{ runs: number; failures: number; avgMs: number } | undefined> {
		const conn = await this.pool.getConnection();
		try {
			const rows = await conn.query<{ runs: number; failures: number | null; avgMs: number | null }[]>(
				"SELECT COUNT(*) AS runs, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures, AVG(duration_ms) AS avgMs FROM tool_runs WHERE tool = ?",
				[tool],
			);
			const row = rows[0];
			if (!row || row.runs === 0) return undefined;
			return { runs: row.runs, failures: row.failures ?? 0, avgMs: row.avgMs ?? 0 };
		} finally {
			conn.release();
		}
	}

	async pruneToolRuns(beforeMs: number): Promise<number> {
		const conn = await this.pool.getConnection();
		try {
			const res = await conn.query("DELETE FROM tool_runs WHERE created_at < ?", [beforeMs]);
			return (res as { affectedRows?: number }).affectedRows ?? 0;
		} finally {
			conn.release();
		}
	}

	async kvGet(namespace: string, key: string): Promise<string | undefined> {
		const conn = await this.pool.getConnection();
		try {
			const rows = await conn.query<Record<string, unknown>[]>("SELECT value FROM kv WHERE ns = ? AND key = ?", [namespace, key]);
			return (rows[0] as { value?: unknown } | undefined)?.value as string | undefined;
		} finally {
			conn.release();
		}
	}

	async kvSet(namespace: string, key: string, value: string): Promise<void> {
		const conn = await this.pool.getConnection();
		try {
			await conn.query(
				"INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)",
				[namespace.slice(0, MAX_KV_NS), key.slice(0, MAX_KV_KEY), value.slice(0, MAX_KV), Date.now()],
			);
		} finally {
			conn.release();
		}
	}

	async kvDelete(namespace: string, key: string): Promise<void> {
		const conn = await this.pool.getConnection();
		try {
			await conn.query("DELETE FROM kv WHERE ns = ? AND key = ?", [namespace, key]);
		} finally {
			conn.release();
		}
	}

	async recentChats(limit: number): Promise<ChatRow[]> {
		const conn = await this.pool.getConnection();
		try {
			const rows = (await conn.query<Record<string, unknown>[]>(
				"SELECT author_id AS author_id, username, guild_id AS guild_id, content, response FROM chats ORDER BY created_at DESC LIMIT ?",
				[Math.min(Math.max(limit, 1), 500)],
			));
			return rows.map((r) => ({
				author_id: String(r.author_id),
				username: String(r.username),
				guild_id: String(r.guild_id ?? ""),
				content: String(r.content ?? ""),
				response: String(r.response ?? ""),
				created_at: Number(r.created_at),
			}));
		} finally {
			conn.release();
		}
	}

	async chatsByUser(authorId: string, limit: number): Promise<ChatRow[]> {
		const conn = await this.pool.getConnection();
		try {
			const rows = (await conn.query<Record<string, unknown>[]>(
				"SELECT author_id AS author_id, username, guild_id AS guild_id, content, response FROM chats WHERE author_id = ? ORDER BY created_at DESC LIMIT ?",
				[authorId, Math.min(Math.max(limit, 1), 500)],
			));
			return rows.map((r) => ({
				author_id: String(r.author_id),
				username: String(r.username),
				guild_id: String(r.guild_id ?? ""),
				content: String(r.content ?? ""),
				response: String(r.response ?? ""),
				created_at: Number(r.created_at),
			}));
		} finally {
			conn.release();
		}
	}
}
