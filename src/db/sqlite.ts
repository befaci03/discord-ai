// better-sqlite3 backend. The database file lives in modules/ (default
// modules/data.sqlite) next to the tools/skills it indexes.

import { mkdirSync } from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import DB, { UserRow, AuditRow, ToolRunRow, ChatRow, ToolRunListener, AuditListener } from "./struct";
import {
	MAX_ID, MAX_USERNAME, MAX_GUILD_ID, MAX_TARGET, MAX_ACTION, MAX_CONTENT, MAX_KV, MAX_KV_KEY, MAX_KV_NS, MAX_TOOL, MAX_CALLER, MAX_ERROR, MAX_DETAILS,
} from "./constants.js";

export default class SQLiteDB implements DB {
	private db: Database.Database;
	private onToolRun: ToolRunListener | null = null;
	private onAudit: AuditListener | null = null;

	constructor(file: string = "./modules/data.sqlite") {
		mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
		this.db = new Database(file);
		this.db.pragma("journal_mode = WAL");
	}

	async init(): Promise<void> {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS users (
				id TEXT PRIMARY KEY,
				username TEXT NOT NULL,
				trust INTEGER NOT NULL DEFAULT 0,
				notes TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS audit (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				actor_id TEXT NOT NULL,
				action TEXT NOT NULL,
				target TEXT NOT NULL,
				details TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS tool_runs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				tool TEXT NOT NULL,
				caller_id TEXT NOT NULL,
				success INTEGER NOT NULL,
				error TEXT NOT NULL DEFAULT '',
				duration_ms INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS kv (
				ns TEXT NOT NULL,
				key TEXT NOT NULL,
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (ns, key)
			);
			CREATE TABLE IF NOT EXISTS chats (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				author_id TEXT NOT NULL,
				username TEXT NOT NULL,
				guild_id TEXT NOT NULL DEFAULT '',
				content TEXT NOT NULL,
				response TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_audit_created ON audit(created_at);
			CREATE INDEX IF NOT EXISTS idx_tool_runs_tool ON tool_runs(tool, created_at);
			CREATE INDEX IF NOT EXISTS idx_chats_author ON chats(author_id, created_at);
			CREATE INDEX IF NOT EXISTS idx_chats_created ON chats(created_at);
		`);
	}

	async close(): Promise<void> {
		this.db.close();
	}

	setOnToolRun(fn: ToolRunListener): void {
		this.onToolRun = fn;
	}
	setOnAudit(fn: AuditListener): void {
		this.onAudit = fn;
	}

	private upsertUserStmt = () =>
		this.db.prepare(`
			INSERT INTO users (id, username, trust, notes, created_at, updated_at)
			VALUES (@id, @username, @trust, @notes, @now, @now)
			ON CONFLICT(id) DO UPDATE SET
				username = excluded.username,
				trust = excluded.trust,
				notes = excluded.notes,
				updated_at = excluded.updated_at
		`);

	async getUser(id: string): Promise<UserRow | undefined> {
		return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
	}

	async upsertUser(user: Pick<UserRow, "id" | "username"> & { trust?: number; notes?: string }): Promise<void> {
		const now = Date.now();
		this.upsertUserStmt().run({
			id: user.id,
			username: user.username,
			trust: user.trust ?? 0,
			notes: (user.notes ?? "").slice(0, MAX_ID),
			now,
		});
	}

	async audit(entry: Omit<AuditRow, "id" | "created_at">): Promise<void> {
		const created = Date.now();
		this.db
			.prepare("INSERT INTO audit (actor_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)")
			.run(entry.actor_id.slice(0, MAX_TARGET), entry.action.slice(0, MAX_ACTION), entry.target.slice(0, MAX_TARGET), entry.details, created);
		try {
			this.onAudit?.({ ...entry, id: undefined, created_at: created } as AuditRow);
		} catch {
			/* listeners must not break writes */
		}
	}

	async recentAudit(limit: number): Promise<AuditRow[]> {
		return this.db
			.prepare("SELECT * FROM audit ORDER BY created_at DESC LIMIT ?")
			.all(Math.min(Math.max(limit, 1), 500)) as AuditRow[];
	}

	async pruneAudit(beforeMs: number): Promise<number> {
		const r = this.db.prepare("DELETE FROM audit WHERE created_at < ?").run(beforeMs);
		return r.changes;
	}

	async recordToolRun(entry: Omit<ToolRunRow, "id" | "created_at">): Promise<void> {
		const created = Date.now();
		this.db
			.prepare("INSERT INTO tool_runs (tool, caller_id, success, error, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)")
			.run(entry.tool.slice(0, MAX_TOOL), entry.caller_id.slice(0, MAX_CALLER), entry.success ? 1 : 0, entry.error.slice(0, MAX_ERROR), entry.duration_ms, created);
		try {
			this.onToolRun?.({ ...entry, id: undefined, created_at: created } as ToolRunRow);
		} catch {
			/* listeners must not break writes */
		}
	}

	async toolStats(tool: string): Promise<{ runs: number; failures: number; avgMs: number } | undefined> {
		const row = this.db
			.prepare("SELECT COUNT(*) AS runs, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures, AVG(duration_ms) AS avgMs FROM tool_runs WHERE tool = ?")
			.get(tool) as { runs: number; failures: number | null; avgMs: number | null } | undefined;
		if (!row || row.runs === 0) return undefined;
		return { runs: row.runs, failures: row.failures ?? 0, avgMs: row.avgMs ?? 0 };
	}

	async pruneToolRuns(beforeMs: number): Promise<number> {
		const r = this.db.prepare("DELETE FROM tool_runs WHERE created_at < ?").run(beforeMs);
		return r.changes;
	}

	async kvGet(ns: string, key: string): Promise<string | undefined> {
		const row = this.db.prepare("SELECT value FROM kv WHERE ns = ? AND key = ?").get(ns.slice(0, MAX_KV_NS), key.slice(0, MAX_KV_KEY)) as { value: string } | undefined;
		return row?.value;
	}

	async kvSet(ns: string, key: string, value: string): Promise<void> {
		this.db
			.prepare(`INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
			.run(ns.slice(0, MAX_KV_NS), key.slice(0, MAX_KV_KEY), value.slice(0, MAX_KV), Date.now());
	}

	async kvDelete(ns: string, key: string): Promise<void> {
		this.db.prepare("DELETE FROM kv WHERE ns = ? AND key = ?").run(ns.slice(0, MAX_KV_NS), key.slice(0, MAX_KV_KEY));
	}

	async recordChat(entry: Omit<ChatRow, "id" | "created_at">): Promise<void> {
		this.db
			.prepare("INSERT INTO chats (author_id, username, guild_id, content, response, created_at) VALUES (?, ?, ?, ?, ?, ?)")
			.run(entry.author_id.slice(0, MAX_ID), entry.username.slice(0, MAX_USERNAME), entry.guild_id.slice(0, MAX_GUILD_ID), entry.content.slice(0, MAX_CONTENT), entry.response.slice(0, MAX_CONTENT), Date.now());
	}

	async recentChats(limit: number): Promise<ChatRow[]> {
		return this.db
			.prepare("SELECT * FROM chats ORDER BY created_at DESC LIMIT ?")
			.all(Math.min(Math.max(limit, 1), 500)) as ChatRow[];
	}

	async chatsByUser(authorId: string, limit: number): Promise<ChatRow[]> {
		return this.db
			.prepare("SELECT * FROM chats WHERE author_id = ? ORDER BY created_at DESC LIMIT ?")
			.all(authorId, Math.min(Math.max(limit, 1), 500)) as ChatRow[];
	}
}
