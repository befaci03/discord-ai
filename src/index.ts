// Entry point: load config, open the DB, load modules, start dashboard + bot.

import { loadConfig } from "./utils/config.js";
import { loadToggles, saveToggles } from "./utils/toggles.js";
import { Logger } from "./utils/logger.js";
import SQLiteDB from "./db/sqlite.js";
import { ToolRegistry } from "./modules/tools.js";
import { SkillRegistry } from "./modules/skills.js";
import { AddonRegistry } from "./modules/addons.js";
import { buildAgent, addonFunctionsToTools, registryToAgentTools } from "./agent/factory.js";
import { startDashboard } from "./dashboard/server.js";
import { hashPasscode, SessionStore, LoginLimiter } from "./dashboard/auth.js";
import { LiveBus } from "./dashboard/live.js";
import { createDB } from "./db/index.js";
import { ToolRunRow, AuditRow } from "./db/struct.js";
import { startBot } from "./bot.js";
import { ToolContext } from "./modules/types.js";
// .env is loaded natively by Bun (shell env still wins over the file)

async function main(): Promise<void> {
	const config = loadConfig();
	if (config.logging.file) Logger.addFileSink(config.logging.file);
	const log = new Logger(config.logging.level, "main");
	log.info("starting discord-ai...");

	if (!config.bot.token) {
		log.error("no discord token: set DISCORD_TOKEN in the environment or bot.token in config.toml");
		process.exit(1);
	}

	// sqlite lives in modules/ next to the tools/skills it indexes
	const db = await createDB(config);
	await db.init();
	log.info(`database ready (${config.database.use})`);

	// runtime toggles from the dashboard survive restarts via modules/config.json
	const toggles = loadToggles();
	const persistToggles = () => {
		try {
			saveToggles({
				tools: Object.fromEntries(tools.runtimeDisabledNames().map((n) => [n, false])),
				skills: Object.fromEntries(skills.runtimeDisabledNames().map((n) => [n, false])),
				addons: Object.fromEntries(addons.runtimeDisabledNames().map((n) => [n, false])),
			});
		} catch (err) {
			log.warn(`could not persist toggles: ${(err as Error).message}`);
		}
	};

	// addons first: they can inject modules into tools
	const addons = new AddonRegistry(config);
	const addonStats = await addons.loadAll();
	// re-disable addons turned off in a previous session (must happen before
	// agentFunctions()/extraVars() are consumed)
	for (const name of Object.keys(toggles.addons)) {
		if (toggles.addons[name] === false) addons.setEnabled(name, false);
	}
	log.info(`addons active: ${addonStats.loaded.join(", ") || "(none)"}` +
		`${addonStats.ignored.length > 0 ? ` | ignored (settings section exists but slug not in addons.enabled): ${addonStats.ignored.join(", ")}` : ""}` +
		`${addonStats.unknown.length > 0 ? ` | unknown: ${addonStats.unknown.join(", ")}` : ""}`);
	for (const note of addonStats.notes) log.info(note);

	const tools = new ToolRegistry(config);
	tools.setContext({
		extraVars: addons.extraVars(),
		envAccess: config.skills.allowEnvAccess === true,
	});
	const toolStats = tools.loadAll();
	// apply persisted runtime toggles after loading (overrides config)
	for (const [name, enabled] of Object.entries(toggles.tools)) {
		if (enabled === false) tools.setEnabled(name, false);
		else if (tools.get(name)) tools.setEnabled(name, true);
	}
	log.info(`tools loaded: ${toolStats.loaded.join(", ") || "(none)"}${toolStats.skipped.length > 0 ? ` | skipped: ${toolStats.skipped.join(", ")}` : ""}`);

	const skills = new SkillRegistry(config);
	const skillStats = skills.loadAll();
	for (const [name, enabled] of Object.entries(toggles.skills)) {
		if (enabled === false) skills.setEnabled(name, false);
		else if (skills.get(name)) skills.setEnabled(name, true);
	}
	log.info(`skills loaded: ${skillStats.loaded.join(", ") || "(none)"}${skillStats.skipped.length > 0 ? ` | skipped: ${skillStats.skipped.join(", ")}` : ""}`);

	// ----- dashboard auth + live updates -----
	const passcode = config.http.passcode;
	if (!passcode) {
		log.error(`no dashboard passcode: set ${config.http.passcode_env ?? "DASHBOARD_PASSCODE"} (or [http].passcode). refusing to start with an unprotected dashboard`);
		process.exit(1);
	}
	const auth = {
		passcodeHash: hashPasscode(passcode),
		sessions: new SessionStore(),
		limiter: new LoginLimiter(),
	};
	const live = new LiveBus(log);

	// tap tool runs + audit entries in the DB layer for live broadcasting
	db.setOnToolRun((entry: ToolRunRow) => live.emit({
				kind: "tool.run",
				tool: entry.tool,
				caller: entry.caller_id,
				ok: entry.success === 1,
				ms: entry.duration_ms,
				error: entry.error || undefined,
			}));
	db.setOnAudit((entry: AuditRow) => live.emit({ kind: "audit", action: entry.action, actor: entry.actor_id, target: entry.target }));

	const dashLog = log.child("dashboard");
	const deps = {
		config, db, tools, skills, addons,
		log: (level: "info" | "warn" | "error", m: string) => dashLog[level](m),
		live,
		onToggle: persistToggles,
	};
	await startDashboard(deps, config, dashLog, auth, live);

	// ----- agent + bot -----
	// one shared tool context: the discord client is filled in by startBot(),
	// so `!tool` runs and the agent's own tool calls hit the same sandbox
	const toolCtx: ToolContext = {
		config,
		log: (level, msg) => log[level](msg),
	};

	// the tool list is built once, so the invoker re-checks addon state at
	// call time: a runtime-disabled addon is refused immediately
	const agentTools = addonFunctionsToTools(
		addons.agentFunctions(),
		async (name, target) => {
			await db.audit({ actor_id: "agent", action: `addon.${name}`, target: target.slice(0, 120), details: "{}" });
		},
		(fnName) => addons.functionEnabled(fnName),
	);
	// enabled .tl tools are callable by the model too (registry re-checks toggles)
	agentTools.push(...registryToAgentTools(tools, toolCtx, db));
	const agent = buildAgent(db, config, agentTools, log); // appends the brain tools
	log.info(`agent functions: ${agentTools.map((t) => t.name).join(", ") || "(none)"}`);

	const client = await startBot({ config, db, tools, skills, addons, log, agent, live, toolCtx });
	void client;

	// graceful shutdown: close the database cleanly on SIGINT/SIGTERM
	process.on("SIGINT", () => {
		log.info("shutting down, closing database...");
		db.close();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		log.info("shutting down, closing database...");
		db.close();
		process.exit(0);
	});
}

// entry point invocation (was missing in every commit: the file only ever
// *declared* main, so running the app loaded it and did nothing)
main().catch((err: unknown) => {
	console.error("[main] fatal:", err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exit(1);
});
