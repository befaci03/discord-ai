// MongoDB backend. Collection layout (mirrors the SQLite schema):
//   users(_id=id, username, trust, notes, created_at, updated_at)
//   audit(_id, actor_id, action, target, details, created_at)
//   tool_runs(_id, tool, caller_id, success, error, duration_ms, created_at)
//   kv(_id=ns+":"+key, ns, key, value, updated_at)
//   chats(_id, author_id, username, guild_id, content, response, created_at)
//
// Indexes: audit.created_at desc, tool_runs.tool+created_at, chats(author_id,
// created_at) and chats.created_at, kv unique (ns, key).

import { MongoClient, Collection, DeleteResult, Document } from "mongodb";
import DB, { UserRow, AuditRow, ToolRunRow, ChatRow, ToolRunListener, AuditListener } from "./struct.js";
import {
	MAX_ID, MAX_USERNAME, MAX_GUILD_ID, MAX_TARGET, MAX_ACTION,
	MAX_CONTENT, MAX_KV, MAX_KV_KEY, MAX_KV_NS, MAX_TOOL, MAX_CALLER, MAX_ERROR, MAX_DETAILS,
} from "./constants.js";

export default class MongoDB implements DB {
	private client: MongoClient;
	// typed wrappers so "Document" is not needed everywhere
	private users: Collection<Document>;
	private auditColl: Collection<Document>;
	private toolRuns: Collection<Document>;
	private kv: Collection<Document>;
	private chats: Collection<Document>;
	private onToolRun: ToolRunListener | null = null;
	private onAudit: AuditListener | null = null;

	constructor(uri: string, database: string) {
		this.client = new MongoClient(uri, {
			maxPoolSize: 5,
			serverSelectionTimeoutMS: 5_000,
			minPoolSize: 0,
		});
		this.users = this.client.db(database).collection("users");
		this.auditColl = this.client.db(database).collection("audit");
		this.toolRuns = this.client.db(database).collection("tool_runs");
		this.kv = this.client.db(database).collection("kv");
		this.chats = this.client.db(database).collection("chats");
	}

	async init(): Promise<void> {
		await this.client.connect();
		const db = this.client.db();
		await db.createCollection("users", { capped: false });
		await this.initIndex("audit", { created_at: -1 });
		await this.initIndex("tool_runs", { tool: 1, created_at: -1 });
		await this.initIndex("chats", { author_id: 1, created_at: -1 });
		await this.initIndex("chats", { created_at: -1 });
		await this.initIndex("kv", { ns: 1, key: 1 }, true); // unique
	}

	private initIndex(name: string, keys: Record<string, 1 | -1>, unique = false): Promise<string> {
		return this.client.db().collection(name).createIndex(keys, { unique, background: true });
	}

	async close(): Promise<void> {
		await this.client.close();
	}

	setOnToolRun(fn: ToolRunListener): void {
		this.onToolRun = fn;
	}
	setOnAudit(fn: AuditListener): void {
		this.onAudit = fn;
	}

	async getUser(id: string): Promise<UserRow | undefined> {
		const doc = await this.users.findOne({ _id: id } as unknown as Document);
		return this.rowToUser(doc);
	}

	async upsertUser(user: Pick<UserRow, "id" | "username"> & { trust?: number; notes?: string }): Promise<void> {
		const now = Date.now();
		await this.users.updateOne(
			{ _id: user.id } as unknown as Document,
			{
				$set: {
					username: user.username,
					trust: user.trust ?? 0,
					notes: (user.notes ?? "").slice(0, MAX_ID),
					created_at: now,
					updated_at: now,
				},
			},
			{ upsert: true },
		);
	}

	async audit(entry: Omit<AuditRow, "id" | "created_at">): Promise<void> {
		const created = Date.now();
		await this.auditColl.insertOne({
			actor_id: entry.actor_id.slice(0, MAX_TARGET),
			action: entry.action.slice(0, MAX_ACTION),
			target: entry.target.slice(0, MAX_TARGET),
			details: entry.details.slice(0, MAX_DETAILS),
			created_at: created,
		} as AuditRow);
		try {
			this.onAudit?.({ ...entry, id: undefined, created_at: created } as AuditRow);
		} catch {
			/* listeners must not break writes */
		}
	}

	async recordToolRun(entry: Omit<ToolRunRow, "id" | "created_at">): Promise<void> {
		const created = Date.now();
		await this.toolRuns.insertOne({
			tool: entry.tool.slice(0, MAX_TOOL),
			caller_id: entry.caller_id.slice(0, MAX_CALLER),
			success: entry.success ? 1 : 0,
			error: entry.error.slice(0, MAX_ERROR),
			duration_ms: entry.duration_ms,
			created_at: created,
		} as ToolRunRow);
		try {
			this.onToolRun?.({ ...entry, id: undefined, created_at: created } as ToolRunRow);
		} catch {
			/* listeners must not break writes */
		}
	}

	async recordChat(entry: Omit<ChatRow, "id" | "created_at">): Promise<void> {
		await this.chats.insertOne({
			author_id: entry.author_id.slice(0, MAX_ID),
			username: entry.username.slice(0, MAX_USERNAME),
			guild_id: entry.guild_id.slice(0, MAX_GUILD_ID),
			content: entry.content.slice(0, MAX_CONTENT),
			response: entry.response.slice(0, MAX_CONTENT),
			created_at: Date.now(),
		} as ChatRow);
	}

	async recentAudit(limit: number): Promise<AuditRow[]> {
		const docs = await this.auditColl.find({}, { sort: { created_at: -1 }, limit: Math.min(Math.max(limit, 1), 500) } as unknown as Document).toArray();
		return docs as unknown as AuditRow[];
	}

	async pruneAudit(beforeMs: number): Promise<number> {
		const res: DeleteResult = await this.auditColl.deleteMany({ created_at: { $lt: beforeMs } } as unknown as Document);
		return res.deletedCount ?? 0;
	}

	async toolStats(tool: string): Promise<{ runs: number; failures: number; avgMs: number } | undefined> {
		const doc = await this.toolRuns.aggregate([
			{ $match: { tool } },
			{
				$group: {
					_id: null,
					runs: { $sum: 1 },
					failures: { $sum: { $cond: [{ $eq: ["$success", 0] }, 1, 0] } },
					avgMs: { $avg: "$duration_ms" },
				},
			},
		]).next();
		if (!doc || doc.runs === 0) return undefined;
		return { runs: doc.runs, failures: doc.failures ?? 0, avgMs: doc.avgMs ?? 0 };
	}

	async pruneToolRuns(beforeMs: number): Promise<number> {
		const res: DeleteResult = await this.toolRuns.deleteMany({ created_at: { $lt: beforeMs } });
		return res.deletedCount ?? 0;
	}

	async kvGet(ns: string, key: string): Promise<string | undefined> {
		const doc = await this.kv.findOne({ ns: ns.slice(0, MAX_KV_NS), key: key.slice(0, MAX_KV_KEY) } as unknown as Document);
		return doc?.value;
	}

	async kvSet(ns: string, key: string, value: string): Promise<void> {
		await this.kv.updateOne(
			{ ns: ns.slice(0, MAX_KV_NS), key: key.slice(0, MAX_KV_KEY) } as unknown as Document,
			{ $set: { value: value.slice(0, MAX_KV), updated_at: Date.now() } },
			{ upsert: true },
		);
	}

	async kvDelete(ns: string, key: string): Promise<void> {
		await this.kv.deleteOne({ ns: ns.slice(0, MAX_KV_NS), key: key.slice(0, MAX_KV_KEY) } as unknown as Document);
	}

	async recentChats(limit: number): Promise<ChatRow[]> {
		const docs = await this.chats.find({}, { sort: { created_at: -1 }, limit: Math.min(Math.max(limit, 1), 500) }).toArray();
		return docs as unknown as ChatRow[];
	}

	async chatsByUser(authorId: string, limit: number): Promise<ChatRow[]> {
		const docs = await this.chats.find({ author_id: authorId }, { sort: { created_at: -1 }, limit: Math.min(Math.max(limit, 1), 500) }).toArray();
		return docs as unknown as ChatRow[];
	}

	private rowToUser(doc: Document | null): UserRow | undefined {
		if (!doc) return undefined;
		return doc as UserRow;
	}
}
