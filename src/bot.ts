// Discord bot bootstrap: wires config, DB, tool/skill registries, the agent
// and the addon modules together.

import { Client, Events, GatewayIntentBits, Message, Partials } from "discord.js";
import { AppConfig } from "./utils/config.js";
import { Logger } from "./utils/logger.js";
import { UserError, toUserMessage } from "./utils/errors.js";
import DB from "./db/struct.js";
import { ToolRegistry, runTool } from "./modules/tools.js";
import { SkillRegistry } from "./modules/skills.js";
import { AddonRegistry } from "./modules/addons.js";
import { ToolContext } from "./modules/types.js";
import { LiveBus } from "./dashboard/live.js";
import Agent, { Tool } from "./agent/struct.js";

export interface BotDeps {
	config: AppConfig;
	db: DB;
	tools: ToolRegistry;
	skills: SkillRegistry;
	addons: AddonRegistry;
	log: Logger;
	agent: Agent | null;
	live?: LiveBus;
}

export function createClient(): Client {
	return new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
			GatewayIntentBits.GuildMembers,
		],
		partials: [Partials.Channel],
	});
}

export async function startBot(deps: BotDeps): Promise<Client> {
	const { config, db, tools, skills, addons, log, agent, live } = deps;
	const client = createClient();

	// expose addon modules to the agent too
	const addonVars = addons.extraVars();

	client.once(Events.ClientReady, (c) => {
		log.info(`logged in as ${c.user.tag} | tools: ${tools.count()} | skills: ${skills.count()} | addons: ${addons.count()} | llm: ${agent ? "on" : "off"}`);
		c.user.setPresence({ activities: [{ name: config.bot.status }], status: "online" });
		live?.emit({ kind: "bot.status", online: true, user: c.user.tag, guilds: c.guilds.cache.size });
	});

	client.on(Events.ShardDisconnect, () => live?.emit({ kind: "bot.status", online: false }));

	client.on(Events.MessageCreate, async (message: Message) => {
		try {
			if (message.author.bot) return;
			if (!message.mentions.has(client.user as never)) return;

			// optional guild scoping: when guild_id is set, ignore other guilds
			if (config.bot.guild_id && message.guildId !== config.bot.guild_id) return;

			const content = message.content.replace(/<@!?[0-9]+>/g, "").trim();
			if (content.length === 0 || content.length > 2000) return; // length limit on untrusted input

			await db.upsertUser({ id: message.author.id, username: message.author.username });

			const ctx: ToolContext = {
				discord: client,
				agent: agent ?? undefined,
				config,
				log: (level, msg) => log[level](msg),
			};

			// explicit tool invocation syntax: !toolname key=value
			const toolMatch = /^!(\w+)(?:\s+(.*))?$/.exec(content);
			if (toolMatch && tools.has(toolMatch[1])) {
				const toolName = toolMatch[1];
				const started = Date.now();
				try {
					const args = parseInlineArgs(toolMatch[2] ?? "");
					const result = await runTool(tools, toolName, args, ctx);
					await db.audit({ actor_id: message.author.id, action: "tool.run", target: toolName, details: "{}" });
					await db.recordToolRun({ tool: toolName, caller_id: message.author.id, success: 1, error: "", duration_ms: Date.now() - started });
					const text = typeof result === "string" ? result : "```json\n" + JSON.stringify(result, null, 2).slice(0, 1800) + "\n```";
					await message.reply(text.slice(0, 2000));
				} catch (err) {
					await db.recordToolRun({ tool: toolName, caller_id: message.author.id, success: 0, error: err instanceof Error ? err.message.slice(0, 200) : "unknown", duration_ms: Date.now() - started });
					await db.audit({ actor_id: message.author.id, action: "tool.fail", target: toolName, details: "{}" });
					await message.reply(`tool error: ${toUserMessage(err)}`.slice(0, 2000));
				}
				return;
			}

			// LLM conversation with matched skills as extra system context
			if (!agent) {
				await message.reply("no LLM provider configured. Set [agent.providers] + [agent.models] in config.toml (and the API key env var).");
				return;
			}
			const skillPrompt = skills.promptFor(content);
			const completion = await agent.ask(content, skillPrompt);
			const reply = completion.choices[0]?.message?.content ?? "";
			if (typeof reply === "string" && reply.length > 0) {
				await db.audit({ actor_id: message.author.id, action: "agent.reply", target: "chat", details: "{}" });
				await message.reply(reply.slice(0, 2000));
			}
			void addonVars;
		} catch (err) {
			log.error("message handler failed:", err instanceof Error ? err.stack : err);
			try { await message.reply(toUserMessage(err)); } catch { /* channel gone, whatever */ }
		}
	});

	await client.login(config.bot.token);
	return client;
}

/** Parse `key=value other="quoted value"` style args. */
export function parseInlineArgs(raw: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const rx = /(\w+)=("([^"]*)"|\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = rx.exec(raw)) !== null) {
		const key = m[1];
		const value = m[3] !== undefined ? m[3] : m[2];
		out[key] = value;
	}
	return out;
}

export { UserError };
export type { Tool };
