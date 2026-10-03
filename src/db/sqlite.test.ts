// bun:sqlite backend tests: every SQLiteDB method against a temp file.
// Guards the migration from better-sqlite3 (which crashes Bun's NAPI layer).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import SQLiteDB from "./sqlite.js";

let dir: string;
let db: SQLiteDB;

beforeAll(async () => {
	dir = mkdtempSync(path.join(tmpdir(), "discord-ai-sqlite-"));
	db = new SQLiteDB(path.join(dir, "test.sqlite"));
	await db.init();
});

afterAll(async () => {
	await db.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("bun:sqlite backend", () => {
	test("upsertUser/getUser: named params in strict mode, missing row is undefined", async () => {
		await db.upsertUser({ id: "u1", username: "buffy", trust: 2, notes: "n1" });
		await db.upsertUser({ id: "u1", username: "buffy2", trust: 3 });
		const u = await db.getUser("u1");
		expect(u?.username).toBe("buffy2");
		expect(u?.trust).toBe(3);
		expect(await db.getUser("nope")).toBeUndefined();
	});

	test("audit writes, notifies the listener, and prunes", async () => {
		let seen = 0;
		db.setOnAudit(() => seen++);
		await db.audit({ actor_id: "u1", action: "test", target: "t", details: "{}" });
		expect(seen).toBe(1);
		expect(await db.recentAudit(10)).toHaveLength(1);
		expect(await db.pruneAudit(Date.now() + 1000)).toBe(1);
	});

	test("recordToolRun and toolStats", async () => {
		await db.recordToolRun({ tool: "weather_now", caller_id: "u1", success: 1, error: "", duration_ms: 100 });
		await db.recordToolRun({ tool: "weather_now", caller_id: "u1", success: 0, error: "boom", duration_ms: 300 });
		expect(await db.toolStats("weather_now")).toEqual({ runs: 2, failures: 1, avgMs: 200 });
		expect(await db.toolStats("never_ran")).toBeUndefined();
		expect(await db.pruneToolRuns(Date.now() + 1000)).toBe(2);
	});

	test("kv upserts, reads back, and deletes", async () => {
		await db.kvSet("ns", "k", "v1");
		await db.kvSet("ns", "k", "v2");
		expect(await db.kvGet("ns", "k")).toBe("v2");
		await db.kvDelete("ns", "k");
		expect(await db.kvGet("ns", "k")).toBeUndefined();
	});

	test("chats are listed and scoped by author", async () => {
		await db.recordChat({ author_id: "u1", username: "buffy", guild_id: "g1", content: "hi", response: "yo" });
		expect(await db.recentChats(10)).toHaveLength(1);
		expect(await db.chatsByUser("u1", 10)).toHaveLength(1);
		expect(await db.chatsByUser("someone-else", 10)).toHaveLength(0);
	});
});
