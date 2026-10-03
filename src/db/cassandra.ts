// Apache Cassandra backend. Cassandra is a partitioned, append-optimised
// database, so the schema is shaped around that:
//
//   users(id PK, username, trust, notes, created_at, updated_at)
//   kv(ns, key, value, updated_at)                PK (ns, key)
//   audit_by_day(day PK, created_at clustering desc, id, actor_id, action,
//                target, details)                  day partition: 'YYYY-MM-DD'
//   audit_days(day PK)                            index of audit days present
//   tool_runs_by_day(day PK, created_at clustering desc, id, tool, caller_id,
//                    success, error, duration_ms)
//   tool_days(tool PK, day)                       which days a tool has runs
//   chat_days(day PK)                             index of chat days present
//   chats_by_day(day PK, created_at clustering desc, id, author_id, username,
//                guild_id, content, response)
//   chats_by_author(author_id PK, created_at clustering desc, id, ...)
//
// Everything is stored as int64 millis; retention is a DELETE by timestamp,
// so it is exact and cheap. recentAudit/recentChats walk day partitions
// newest-first until the limit is met (Cassandra sorts within a partition
// only).

import { Client, types } from "cassandra-driver";

import _DB, { UserRow, AuditRow, ToolRunRow, ChatRow, ToolRunListener } from "./struct.js";
import {
	MAX_ID, MAX_USERNAME, MAX_GUILD_ID, MAX_TARGET, MAX_ACTION,
	MAX_CONTENT, MAX_KV, MAX_KV_KEY, MAX_KV_NS, MAX_TOOL, MAX_CALLER, MAX_ERROR, MAX_DETAILS,
} from "./constants.js";

const DAY_S = 86_400_000;
const EPOCH = Date.UTC(2025, 0, 1);
const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }); // YYYY-MM-DD

function dayKey(ts: number): string {
	return DAY_FORMAT.format(new Date(ts));
}

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

function parseRows<T>(rows: unknown[]): T[] {
	return rows as T[];
}

export class CassandraDB implements _DB {
	private client: Client;
	private contactPoints: string[];
	private localDataCenter: string;
	private onToolRun: ToolRunListener | null = null;
	private onAudit: ((entry: AuditRow) => void) | null = null;

	constructor(opts: { contact_points: string[]; local_datacenter: string; keyspace: string }) {
		this.contactPoints = opts.contact_points;
		this.localDataCenter = opts.local_datacenter;
		this.client = new Client({
			contactPoints: this.contactPoints,
			localDataCenter: this.localDataCenter,
			keyspace: opts.keyspace,
			socketOptions: { connectTimeout: 5_000 },
			queryOptions: { prepare: true },
		});
	}

	async init(): Promise<void> {
		const keyspaceExists = await this.keyspaceExists();
		if (!keyspaceExists) {
			await this.createKeyspace();
		}
		await this.createTables();
	}

	async close(): Promise<void> {
		await this.client.shutdown();
	}

	setOnToolRun(fn: ToolRunListener): void {
		this.onToolRun = fn;
	}
	setOnAudit(fn: (entry: AuditRow) => void): void {
		this.onAudit = fn;
	}

	async getUser(id: string): Promise<UserRow | undefined> {
		const rows = await this.client.execute("SELECT * FROM users WHERE id = ?", [id], { prepare: true });
		return parseRows(rows.rows)[0] as UserRow | undefined;
	}

	async upsertUser(user: Pick<UserRow, "id" | "username"> & { trust?: number; notes?: string }): Promise<void> {
		const now = Date.now();
		// Cassandra INSERT is upsert here: a missing row creates it, existing
		// row is replaced by the same PK.
		await this.client.execute(
			`INSERT INTO users (id, username, trust, notes, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
			[user.id, user.username, user.trust ?? 0, (user.notes ?? "").slice(0, MAX_ID), now, now],
			{ prepare: true },
		);
	}

	async audit(entry: Omit<AuditRow, "id" | "created_at">): Promise<void> {
		const created = Date.now();
		const day = dayKey(created);
		await this.client.execute(
			`INSERT INTO audit_by_day (day, created_at, id, actor_id, action, target, details)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[day, created, types.Uuid.random(), entry.actor_id.slice(0, MAX_TARGET), entry.action.slice(0, MAX_ACTION), entry.target.slice(0, MAX_TARGET), entry.details.slice(0, MAX_DETAILS)],
			{ prepare: true },
		);
		await this.client.execute("INSERT INTO audit_days (day) VALUES (?) IF NOT EXISTS", [day], { prepare: true });
		try {
			this.onAudit?.({ ...entry, id: undefined, created_at: created } as AuditRow);
		} catch {
			/* listeners must not break writes */
		}
	}

	async recordToolRun(entry: Omit<ToolRunRow, "id" | "created_at">): Promise<void> {
		const created = Date.now();
		const day = dayKey(created);
		await this.client.execute(
			`INSERT INTO tool_runs_by_day (day, created_at, id, tool, caller_id, success, error, duration_ms)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[day, created, types.Uuid.random(), entry.tool.slice(0, MAX_TOOL), entry.caller_id.slice(0, MAX_CALLER), entry.success ? 1 : 0, entry.error.slice(0, MAX_ERROR), entry.duration_ms],
			{ prepare: true },
		);
		await this.client.execute("INSERT INTO tool_days (tool, day) VALUES (?, ?) IF NOT EXISTS", [entry.tool, day], { prepare: true });
		try {
			this.onToolRun?.({ ...entry, id: undefined, created_at: created } as ToolRunRow);
		} catch {
			/* listeners must not break writes */
		}
	}

	async recordChat(entry: Omit<ChatRow, "id" | "created_at">): Promise<void> {
		const created = Date.now();
		const day = dayKey(created);
		const id = types.Uuid.random();
		await this.client.execute(
			`INSERT INTO chats_by_day (day, created_at, id, author_id, username, guild_id, content, response)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[day, created, id, entry.author_id.slice(0, MAX_ID), entry.username.slice(0, MAX_USERNAME), entry.guild_id.slice(0, MAX_GUILD_ID), entry.content.slice(0, MAX_CONTENT), entry.response.slice(0, MAX_CONTENT)],
			{ prepare: true },
		);
		await this.client.execute(
			`INSERT INTO chats_by_author (author_id, created_at, id, username, guild_id, content, response)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[entry.author_id, created, id, entry.username.slice(0, MAX_USERNAME), entry.guild_id.slice(0, MAX_GUILD_ID), entry.content.slice(0, MAX_CONTENT), entry.response.slice(0, MAX_CONTENT)],
			{ prepare: true },
		);
		await this.client.execute("INSERT INTO chat_days (day) VALUES (?) IF NOT EXISTS", [day], { prepare: true });
	}

	async recentAudit(limit: number): Promise<AuditRow[]> {
		const out: AuditRow[] = [];
		let remaining = limit;
		const endDay = dayKey(Date.now());
		let day = endDay;
		while (remaining > 0 && out.length < limit) {
			const rows = await this.client.execute(
				"SELECT * FROM audit_by_day WHERE day = ? ORDER BY created_at DESC LIMIT ?",
				[day, remaining],
				{ prepare: true },
			);
			const items = parseRows<AuditRow>(rows.rows);
			if (items.length === 0) {
				const prev = new Date(parseInt(day.slice(0, 4) ?? "2025"), parseInt(day.slice(5, 7) ?? "01") - 1, 1);
				day = dayKey(prev.getTime());
				continue;
			}
			out.push(...items);
			remaining -= items.length;
		}
		return out;
	}

	async pruneAudit(beforeMs: number): Promise<number> {
		const beforeDay = dayKey(beforeMs - (DAY_S - 1));
		let total = 0;
		const days: string[] = [];
		for (let t = EPOCH; t <= Date.now() && days.length < 4_000; t += DAY_S) {
			const d = dayKey(t);
			if (d < beforeDay) days.push(d);
		}
		for (const batch of chunk(days, 100)) {
			for (const b of batch) {
				await this.client.execute("DELETE FROM audit_by_day WHERE day = ?", [b], { prepare: true });
				const cnt = await this.client.execute("SELECT COUNT(*) AS n FROM audit_by_day WHERE day = ?", [b], { prepare: true });
				total += cnt.rows[0].n;
			}
		}
		return total;
	}

	async toolStats(tool: string): Promise<{ runs: number; failures: number; avgMs: number } | undefined> {
		const days = await this.client.execute("SELECT day FROM tool_days WHERE tool = ?", [tool], { prepare: true });
		const dayNames = parseRows<{ day: string }>(days.rows).map((r) => r.day);
		if (dayNames.length === 0) return undefined;
		let runs = 0;
		let failures = 0;
		let sumMs = 0;
		for (const day of dayNames) {
			const rows = await this.client.execute(
				"SELECT success, duration_ms FROM tool_runs_by_day WHERE day = ? AND tool = ? ORDER BY created_at DESC LIMIT 50000",
				[day, tool],
				{ prepare: true },
			);
			for (const it of parseRows<{ success: number; duration_ms: number }>(rows.rows)) {
				runs++;
				if (it.success === 0) failures++;
				else sumMs += it.duration_ms;
			}
			if (runs >= 50_000) break; // cap so a monster day can't hang stats
		}
		if (runs === 0) return undefined;
		return { runs, failures, avgMs: sumMs / runs };
	}

	async pruneToolRuns(beforeMs: number): Promise<number> {
		const beforeDay = dayKey(beforeMs - (DAY_S - 1));
		let total = 0;
		const days: string[] = [];
		for (let t = EPOCH; t <= Date.now() && days.length < 4_000; t += DAY_S) {
			const d = dayKey(t);
			if (d < beforeDay) days.push(d);
		}
		for (const batch of chunk(days, 100)) {
			for (const b of batch) {
				await this.client.execute("DELETE FROM tool_runs_by_day WHERE day = ?", [b], { prepare: true });
				const cnt = await this.client.execute("SELECT COUNT(*) AS n FROM tool_runs_by_day WHERE day = ?", [b], { prepare: true });
				total += cnt.rows[0].n;
			}
		}
		return total;
	}

	async kvGet(ns: string, key: string): Promise<string | undefined> {
		const rows = await this.client.execute("SELECT `value` FROM kv WHERE ns = ? AND `key` = ?", [ns.slice(0, MAX_KV_NS), key.slice(0, MAX_KV_KEY)], { prepare: true });
		return parseRows<{ value: string }>(rows.rows)[0]?.value;
	}

	async kvSet(namespace: string, key: string, value: string): Promise<void> {
		await this.client.execute(
			`INSERT INTO kv (ns, "key", "value", updated_at) VALUES (?, ?, ?, ?)`,
			[namespace.slice(0, MAX_KV_NS), key.slice(0, MAX_KV_KEY), value.slice(0, MAX_KV), Date.now()],
			{ prepare: true },
		);
	}

	async kvDelete(namespace: string, key: string): Promise<void> {
		await this.client.execute("DELETE FROM kv WHERE ns = ? AND `key` = ?", [namespace.slice(0, MAX_KV_NS), key.slice(0, MAX_KV_KEY)], { prepare: true });
	}

	async recentChats(limit: number): Promise<ChatRow[]> {
		const out: ChatRow[] = [];
		let remaining = limit;
		const endDay = dayKey(Date.now());
		let day = endDay;
		while (remaining > 0 && out.length < limit) {
			const rows = await this.client.execute(
				"SELECT * FROM chats_by_day WHERE day = ? ORDER BY created_at DESC LIMIT ?",
				[day, remaining],
				{ prepare: true },
			);
			const items = parseRows<ChatRow>(rows.rows);
			if (items.length === 0) {
				const prev = new Date(parseInt(day.slice(0, 4) ?? "2025"), parseInt(day.slice(5, 7) ?? "01") - 1, 1);
				day = dayKey(prev.getTime());
				continue;
			}
			out.push(...items);
			remaining -= items.length;
		}
		return out;
	}

	async chatsByUser(authorId: string, limit: number): Promise<ChatRow[]> {
		const rows = await this.client.execute(
			"SELECT * FROM chats_by_author WHERE author_id = ? ORDER BY created_at DESC LIMIT ?",
			[authorId, Math.min(Math.max(limit, 1), 500)],
			{ prepare: true },
		);
		return parseRows<ChatRow>(rows.rows);
	}

	private async keyspaceExists(): Promise<boolean> {
		try {
			await this.client.execute("SELECT keyspace_name FROM system_schema.keyspaces WHERE keyspace_name = ?", [this.client.keyspace], { prepare: true });
			return true;
		} catch {
			return false;
		}
	}

	private async createKeyspace(): Promise<void> {
		const meta = new Client({
			contactPoints: this.contactPoints,
			localDataCenter: this.localDataCenter,
			socketOptions: { connectTimeout: 5_000 },
			queryOptions: { prepare: true },
		});
		try {
			await meta.connect();
			await meta.execute(`CREATE KEYSPACE IF NOT EXISTS "${this.client.keyspace}" WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`, [], { prepare: true });
		} finally {
			await meta.shutdown();
		}
	}

	private async createTables(): Promise<void> {
		await this.client.execute(
			`
			CREATE TABLE IF NOT EXISTS users (
				id TEXT PRIMARY KEY,
				username TEXT,
				trust INTEGER,
				notes TEXT,
				created_at BIGINT,
				updated_at BIGINT
			);
			CREATE TABLE IF NOT EXISTS kv (
				ns TEXT,
				"key" TEXT,
				"value" TEXT,
				updated_at BIGINT,
				PRIMARY KEY (ns, "key")
			);
			CREATE TABLE IF NOT EXISTS audit_by_day (
				day TEXT,
				created_at BIGINT,
				id UUID,
				actor_id TEXT,
				action TEXT,
				target TEXT,
				details TEXT,
				PRIMARY KEY ((day), created_at DESC, id)
			) WITH CLUSTERING ORDER BY (created_at DESC);
			CREATE TABLE IF NOT EXISTS audit_days (
				day TEXT,
				PRIMARY KEY (day)
			);
			CREATE TABLE IF NOT EXISTS tool_runs_by_day (
				day TEXT,
				created_at BIGINT,
				id UUID,
				tool TEXT,
				caller_id TEXT,
				success INTEGER,
				error TEXT,
				duration_ms BIGINT,
				PRIMARY KEY ((day), created_at DESC, id)
			) WITH CLUSTERING ORDER BY (created_at DESC);
			CREATE TABLE IF NOT EXISTS tool_days (
				tool TEXT,
				day TEXT,
				PRIMARY KEY (tool, day)
			);
			CREATE TABLE IF NOT EXISTS chat_days (
				day TEXT,
				PRIMARY KEY (day)
			);
			CREATE TABLE IF NOT EXISTS chats_by_day (
				day TEXT,
				created_at BIGINT,
				id UUID,
				author_id TEXT,
				username TEXT,
				guild_id TEXT,
				content TEXT,
				response TEXT,
				PRIMARY KEY ((day), created_at DESC, id)
			) WITH CLUSTERING ORDER BY (created_at DESC);
			CREATE TABLE IF NOT EXISTS chats_by_author (
				author_id TEXT,
				created_at BIGINT,
				id UUID,
				username TEXT,
				guild_id TEXT,
				content TEXT,
				response TEXT,
				PRIMARY KEY ((author_id), created_at DESC, id)
			) WITH CLUSTERING ORDER BY (created_at DESC);
			CREATE INDEX IF NOT EXISTS idx_audit_days ON audit_days(day);
			CREATE INDEX IF NOT EXISTS idx_tool_days ON tool_days(tool);
			CREATE INDEX IF NOT EXISTS idx_chat_days ON chat_days(day);
			CREATE INDEX IF NOT EXISTS idx_chat_authors ON chats_by_author(author_id);
			`,
			[],
		);
	}
}
