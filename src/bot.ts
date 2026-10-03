// Discord bot bootstrap: wires config, DB, tool/skill registries, the agent
// and the addon modules together.

import { Client, Events, GatewayIntentBits, Message, Partials, type MessageMentionTypes } from "discord.js";
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
	/** shared tool context, reused by the agent's own tool calls (index.ts builds it) */
	toolCtx: ToolContext;
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

/** Permissions worth telling the model about (it decides what it may do). */
const TRACKED_PERMS = [
	"Administrator",
	"ManageGuild",
	"ManageChannels",
	"ManageRoles",
	"ManageMessages",
	"ModerateMembers",
	"KickMembers",
	"BanMembers",
	"SendMessages",
	"SendMessagesInThreads",
	"EmbedLinks",
	"AttachFiles",
	"ReadMessageHistory",
	"MentionEveryone",
	"Connect",
	"Speak",
	"UseExternalEmojis",
] as const;

/** Model output must never ping anyone: no @everyone/@here/roles/users. */
const NO_PINGS = { parse: [] as MessageMentionTypes[] };

/** Subset reported for the human you are talking to: changes how you reply. */
const ELEVATED_PERMS = [
	"Administrator",
	"ManageGuild",
	"ManageChannels",
	"ManageRoles",
	"ManageMessages",
	"ModerateMembers",
	"KickMembers",
	"BanMembers",
] as const;

export async function startBot(deps: BotDeps): Promise<Client> {
	const { config, db, tools, skills, addons, log, agent, live, toolCtx } = deps;
	const client = createClient();
	// the shared context is what the LLM's tool calls run with: bind the client
	toolCtx.discord = client;
	toolCtx.agent = agent ?? undefined;

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

			const ctx = toolCtx; // one sandbox for `!tool` and for the model's tool calls

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
					await message.reply({ content: text.slice(0, 2000), allowedMentions: NO_PINGS });
				} catch (err) {
					await db.recordToolRun({ tool: toolName, caller_id: message.author.id, success: 0, error: err instanceof Error ? err.message.slice(0, 200) : "unknown", duration_ms: Date.now() - started });
					await db.audit({ actor_id: message.author.id, action: "tool.fail", target: toolName, details: "{}" });
					await message.reply({ content: `tool error: ${toUserMessage(err)}`.slice(0, 2000), allowedMentions: NO_PINGS });
				}
				return;
			}

			// LLM conversation with matched skills as extra system context
			if (!agent) {
				await message.reply({ content: "no LLM provider configured. Set [agent.providers] + [agent.models] in config.toml (and the API key env var).", allowedMentions: NO_PINGS });
				return;
			}
			const skillPrompt = skills.promptFor(content);
			// skills first, then who is talking + what the bot may actually do here
			const system = [skillPrompt, discordContext(message)].filter((s) => s.trim().length > 0).join("\n");
			const completion = await agent.ask(content, system, { speakerId: message.author.id });
			const reply = completion.choices[0]?.message?.content ?? "";
			if (typeof reply === "string" && reply.length > 0) {
				await message.reply({ content: reply.slice(0, 2000), allowedMentions: NO_PINGS });
				await db.audit({ actor_id: message.author.id, action: "agent.reply", target: "chat", details: "{}" });
				// persisted so memory survives a restart (Brain.bootstraps from this)
				await db.recordChat({
					author_id: message.author.id,
					username: message.author.username,
					guild_id: message.guildId ?? "",
					content,
					response: reply,
				});
			}
		} catch (err) {
			log.error("message handler failed:", err instanceof Error ? err.stack : err);
			try { await message.reply({ content: toUserMessage(err), allowedMentions: NO_PINGS }); } catch { /* channel gone, whatever */ }
		}
	});

	await client.login(config.bot.token);
	return client;
}

/**
 * Per-ask context: who is talking, and what the bot may actually do here.
 * The model has no other way to introspect Discord permissions, so it used to
 * happily promise kicks and embeds it cannot send.
 */
export function discordContext(message: Message): string {
	const lines: string[] = [];
	const ch = message.channel as { name?: string; permissionsFor?: (member: unknown) => { toArray(): string[] } | null };
	const where = ch.name ? `#${ch.name}` : "direct messages";
	const whereIn = message.guild ? `${where} of server '${message.guild.name}'` : where;
	lines.push(`You are talking to ${message.author.displayName} (@${message.author.username}, id ${message.author.id}) in ${whereIn}.`);

	// what the bot itself may do in this channel
	const me = message.guild?.members.me;
	const botPerms = me && typeof ch.permissionsFor === "function" ? ch.permissionsFor(me)?.toArray() ?? [] : null;
	if (botPerms) {
		const have = TRACKED_PERMS.filter((p) => botPerms.includes(p));
		const missing = TRACKED_PERMS.filter((p) => !botPerms.includes(p));
		lines.push(`Your permissions here: ${have.join(", ") || "none"}. Missing: ${missing.join(", ") || "none"}.`);
		lines.push("Only act within the permissions you have; if one is missing, say so instead of trying.");
	}

	// who you are talking to: roles + the elevated rights that change how you reply
	if (message.member) {
		const roles = message.member.roles.cache.map((r) => r.name).filter((n) => n !== "@everyone").slice(0, 10);
		if (roles.length > 0) lines.push(`Their roles: ${roles.join(", ")}.`);
		const speakerPerms = typeof ch.permissionsFor === "function" ? ch.permissionsFor(message.member)?.toArray() ?? [] : [];
		const elevated = ELEVATED_PERMS.filter((p) => speakerPerms.includes(p));
		if (elevated.length > 0) lines.push(`They hold elevated permissions: ${elevated.join(", ")} (treat them accordingly).`);
	}
	return lines.join("\n");
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
