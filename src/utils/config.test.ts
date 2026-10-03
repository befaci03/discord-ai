// Config: snake_case keys in example.config.toml must land on the real
// settings (they used to be silently ignored), and [agent.brain] gets clamped.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadConfig, resetConfigCache } from "./config.js";

describe("config key mapping", () => {
	beforeEach(() => resetConfigCache());
	afterEach(() => resetConfigCache());

	test("snake_case keys in the example map onto the camelCase settings", () => {
		const cfg = loadConfig("example.config.toml");
		expect(cfg.http.allowedIps).toEqual(["127.0.0.1"]);
		expect(cfg.skills.allowEnvAccess).toBe(false);
		expect(cfg.docker.allowedPorts).toEqual(["3456-35665"]);
		expect(cfg.docker.disallowedImages).toEqual(["ftp", "ssh", "windows"]);
		expect(cfg.docker.maxContainers).toBe(100);
		expect(cfg.agent.toolang.maxLoopIterations).toBe(10000);
		expect(cfg.agent.toolang.toolTimeoutMs).toBe(30000);
		expect(cfg.agent.toolang.http.blockPrivate).toBe(true);
		expect(cfg.agent.toolang.fs.allowWrite).toBe(true);
	});

	test("keys spelled snake_case in code keep their name", () => {
		const cfg = loadConfig("example.config.toml");
		expect(cfg.http.passcode_env).toBe("DASHBOARD_PASSCODE");
		expect(cfg.bot.guild_id).toBe("");
		expect(cfg.agent.models.use_same_models).toBe(true);
	});

	test("the example ships the documented brain defaults", () => {
		const cfg = loadConfig("example.config.toml");
		expect(cfg.agent.brain.memory).toBe(30);
		expect(cfg.agent.brain.reset).toBe(false);
		expect(cfg.agent.brain.likes).toEqual([]);
		expect(cfg.agent.brain.people).toEqual({});
	});
});

describe("[agent.brain] validation", () => {
	let dir: string;

	beforeEach(() => {
		resetConfigCache();
		dir = mkdtempSync(path.join(tmpdir(), "discord-ai-cfg-"));
	});

	afterEach(() => {
		resetConfigCache();
		rmSync(dir, { recursive: true, force: true });
	});

	function loadWith(body: string) {
		const file = path.join(dir, "config.toml");
		writeFileSync(file, body);
		resetConfigCache(); // loadConfig memoizes: each file must be read fresh
		return loadConfig(file);
	}

	test("memory is clamped to 0..200", () => {
		expect(loadWith("[agent.brain]\nmemory = 99999\n").agent.brain.memory).toBe(200);
		expect(loadWith("[agent.brain]\nmemory = -5\n").agent.brain.memory).toBe(0);
		expect(loadWith("[agent.brain]\nmemory = \"lots\"\n").agent.brain.memory).toBe(30);
	});

	test("taste lists accept arrays and comma strings, junk is dropped", () => {
		const cfg = loadWith("[agent.brain]\nlikes = \"rust, php , ,\"\ndislikes = [\"crypto ads\", \"\"]\n");
		expect(cfg.agent.brain.likes).toEqual(["rust", "php"]);
		expect(cfg.agent.brain.dislikes).toEqual(["crypto ads"]);
	});

	test("reset only flips on a real boolean true", () => {
		expect(loadWith("[agent.brain]\nreset = true\n").agent.brain.reset).toBe(true);
		expect(loadWith("[agent.brain]\nreset = \"yes\"\n").agent.brain.reset).toBe(false);
	});

	test("seeded people get normalized profiles", () => {
		const cfg = loadWith(`[agent.brain.people]\n"12345" = { description = "friend", likes = "a, b" }\n`);
		expect(cfg.agent.brain.people["12345"].description).toBe("friend");
		expect(cfg.agent.brain.people["12345"].likes).toEqual(["a", "b"]);
		expect(cfg.agent.brain.people["12345"].personalities).toEqual([]);
	});

	test("a config without a brain section still boots with defaults", () => {
		const cfg = loadWith("[bot]\nstatus = \"hi\"\n");
		expect(cfg.agent.brain.memory).toBe(30);
		expect(cfg.agent.brain.people).toEqual({});
	});
});
