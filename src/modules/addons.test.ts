// The addons.enabled contract: only slugs listed in addons.enabled load, an
// [addons.<slug>] settings section never enables anything by itself, and
// sections outside the list are reported as ignored at startup.

import { loadConfig, resetConfigCache, AppConfig } from "../utils/config.js";
import { AddonRegistry } from "./addons.js";

/** example-config based fixture with settings sections for github + tunnel */
function makeConfig(enabled: string[], sections: Record<string, unknown> = {}): AppConfig {
	const base = loadConfig("example.config.toml");
	return { ...base, addons: { enabled, github: {}, tunnel: {}, ...sections } } as AppConfig;
}

describe("addons.enabled gate", () => {
	beforeEach(() => {
		resetConfigCache();
		// named tunnel mode must stay tokenless so it never spawns cloudflared
		delete process.env.CF_TUNNEL_TOKEN;
	});

	test("only slugs in addons.enabled are loaded", async () => {
		const addons = new AddonRegistry(makeConfig(["weather"]));
		const stats = await addons.loadAll();
		expect(stats.loaded).toEqual(["weather"]);
		expect(stats.unknown).toEqual([]);
		expect(addons.agentFunctions().map((f) => f.name)).toEqual(["weather_now", "weather_forecast"]);
		expect(addons.isEnabled("github")).toBe(false);
		expect(addons.functionEnabled("github_create_issue")).toBe(false);
		expect(addons.functionEnabled("weather_now")).toBe(true);
	});

	test("[addons.github] settings alone never enable github", async () => {
		const addons = new AddonRegistry(makeConfig([], { github: { default_owner: "someone", allowed_repos: [] } }));
		const stats = await addons.loadAll();
		expect(stats.loaded).toEqual([]);
		expect(stats.ignored).toEqual(["github", "tunnel"]);
		expect(addons.agentFunctions()).toEqual([]);
		expect(addons.count()).toBe(0);
	});

	test("reports settings sections that are not in addons.enabled", async () => {
		const addons = new AddonRegistry(makeConfig(["weather"]));
		const stats = await addons.loadAll();
		expect([...stats.ignored].sort()).toEqual(["github", "tunnel"]);
	});

	test("unknown slugs are reported, not loaded", async () => {
		const addons = new AddonRegistry(makeConfig(["does-not-exist"]));
		const stats = await addons.loadAll();
		expect(stats.loaded).toEqual([]);
		expect(stats.unknown).toEqual(["does-not-exist"]);
		const status = addons.status();
		expect(status).toHaveLength(1);
		expect(status[0].configured).toBe(false);
		expect(status[0].error).toBe("unknown addon");
	});

	test("tunnel in named mode without a token stays unconfigured", async () => {
		const addons = new AddonRegistry(makeConfig(["tunnel"], { tunnel: { mode: "named" } }));
		const stats = await addons.loadAll();
		// init returns false (no token): not loaded, but not "ignored" either.
		// the github section of the fixture IS ignored, tunnel is enabled-but-unconfigured
		expect(stats.loaded).toEqual([]);
		expect(stats.ignored).toEqual(["github"]);
		expect(addons.status()[0].error).toBe("not configured (missing keys/env)");
		// no agent functions, so nothing ever spawned cloudflared
		expect(addons.agentFunctions()).toEqual([]);
	});

	test("a runtime toggle disables a loaded addon without unloading it", async () => {
		const addons = new AddonRegistry(makeConfig(["weather"]));
		await addons.loadAll();
		expect(addons.setEnabled("weather", false)).toBe(false);
		expect(addons.isEnabled("weather")).toBe(false);
		expect(addons.agentFunctions()).toEqual([]);
		expect(addons.setEnabled("weather", true)).toBe(true);
		expect(addons.agentFunctions()).toHaveLength(2);
	});
});

describe("example.config.toml addons parsing", () => {
	beforeEach(() => resetConfigCache());

	test("addons.enabled survives parsing and stays at the root", () => {
		const cfg = loadConfig("example.config.toml");
		expect(cfg.addons.enabled).toEqual(["weather"]);
		// the settings section is preserved next to the gate
		expect(cfg.addons).toHaveProperty("github");
		// regression: a dotted `addons.enabled = [...]` written after a table
		// header used to land inside [agent.models] and vanish from the root
		expect((cfg.agent.models as unknown as Record<string, unknown>).addons).toBeUndefined();
	});
});
