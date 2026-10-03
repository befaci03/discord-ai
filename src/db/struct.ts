// Database interface. Implementations live next to this file (sqlite.ts).
// Every read/write goes through the driver, so every method here is async
// and returns a Promise. Synchronous helpers (getCurrentUser etc.) are NOT
// part of this interface: the database is a network/tracking layer, not a
// thread-safe in-memory store.
//
// Row types: UserRow, AuditRow, ToolRunRow, ChatRow are shared so all
// backends (sqlite, postgres, mariadb, mongodb, cassandra) agree on the
// shape of data both written and read.

export interface UserRow {
	id: string; // discord snowflake
	username: string;
	trust: number; // -3..2000
	notes: string;
	created_at: number;
	updated_at: number;
}

export interface AuditRow {
	id?: number;
	actor_id: string; // who triggered the action (user id or "agent")
	action: string; // e.g. "tool.run", "member.kick"
	target: string; // what it was applied to
	details: string; // json, no secrets
	created_at: number;
}

export interface ToolRunRow {
	id?: number;
	tool: string;
	caller_id: string;
	success: number; // 0/1
	error: string;
	duration_ms: number;
	created_at: number;
}

export interface ChatRow {
	id?: number;
	author_id: string; // discord user id
	username: string;
	guild_id: string; // "" for DMs
	content: string; // user message (size-capped at insert)
	response: string; // agent reply (size-capped)
	created_at: number;
}

export type ToolRunListener = (entry: ToolRunRow) => void;
export type AuditListener = (entry: AuditRow) => void;

/** The full database contract. All methods are async. */
export default interface DB {
	init(): Promise<void>;
	close(): void;

	/** optional live-update hooks (dashboard WebSocket feed) */
	setOnToolRun?(fn: ToolRunListener): void;
	setOnAudit?(fn: AuditListener): void;

	/** Best-effort read; returns undefined when the record does not exist. */
	getUser(id: string): Promise<UserRow | undefined>;
	upsertUser(user: Pick<UserRow, "id" | "username"> & { trust?: number; notes?: string }): Promise<void>;

	audit(entry: Omit<AuditRow, "id" | "created_at">): Promise<void>;
	recentAudit(limit: number): Promise<AuditRow[]>;
	/** delete audit entries older than the given epoch ms; returns rows removed */
	pruneAudit(beforeMs: number): Promise<number>;

	recordToolRun(entry: Omit<ToolRunRow, "id" | "created_at">): Promise<void>;
	toolStats(tool: string): Promise<{ runs: number; failures: number; avgMs: number } | undefined>;
	/** delete tool runs older than the given epoch ms; returns rows removed */
	pruneToolRuns(beforeMs: number): Promise<number>;

	/** tiny namespaced key-value store for runtime state that belongs in the DB */
	kvGet(ns: string, key: string): Promise<string | undefined>;
	kvSet(ns: string, key: string, value: string): Promise<void>;
	kvDelete(ns: string, key: string): Promise<void>;

	/** chat history: what users asked and what the agent answered */
	recordChat(entry: Omit<ChatRow, "id" | "created_at">): Promise<void>;
	recentChats(limit: number): Promise<ChatRow[]>;
	chatsByUser(authorId: string, limit: number): Promise<ChatRow[]>;
}
