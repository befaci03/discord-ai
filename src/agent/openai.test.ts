// OpenAI agent against a local mock server: proves the tool loop behaves and,
// more importantly, that a plain answer costs exactly ONE API call (a bug once
// made every ask burn a second call and discard the real answer).

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import OpenAIAgent from "./openai.js";
import { Model, Provider, Tool } from "./struct.js";
import SQLiteDB from "../db/sqlite.js";
import { Logger } from "../utils/logger.js";

let dir: string;
let db: SQLiteDB;
let server: ReturnType<typeof Bun.serve>;
let provider: Provider;
let model: Model;

/** queued mock replies: "text" = plain answer, "tool" = tool call request */
let script: ("text" | "tool")[] = ["text"];
/** every request body the mock received, in order */
let seen: Record<string, never>[] = [];

const PROVIDER: Provider = { apiType: 1, baseUrl: "", apiKey: "sk-test" };

function nextBody(): Record<string, unknown> {
	const kind = script.length > 1 ? script.shift()! : script[0];
	if (kind === "tool") {
		return {
			id: "chatcmpl-tool",
			object: "chat.completion",
			created: 0,
			model: "gpt-test",
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: null,
						tool_calls: [{ id: "call_1", type: "function", function: { name: "echo_tool", arguments: '{"x":"hi"}' } }],
					},
					finish_reason: "tool_calls",
				},
			],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		};
	}
	return {
		id: "chatcmpl-text",
		object: "chat.completion",
		created: 0,
		model: "gpt-test",
		choices: [{ index: 0, message: { role: "assistant", content: "bonjour" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
}

beforeAll(async () => {
	dir = mkdtempSync(path.join(tmpdir(), "discord-ai-openai-"));
	db = new SQLiteDB(path.join(dir, "agent.sqlite"));
	await db.init();

	server = Bun.serve({
		port: 0,
		async fetch(req) {
			try {
				seen.push((await req.json()) as Record<string, never>);
			} catch {
				seen.push({} as Record<string, never>);
			}
			return Response.json(nextBody());
		},
	});
	provider = { apiType: 1, baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "sk-test" };
	model = { type: "default", provider, name: "gpt-test" };
});

afterAll(async () => {
	server.stop(true);
	await db.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	script = ["text"];
	seen = [];
});

function makeAgent(tools: Tool[] = []): OpenAIAgent {
	return new OpenAIAgent(db, provider, [model], "You are a test agent.", tools, 4, new Logger("error"));
}

describe("OpenAI agent", () => {
	test("a plain answer costs exactly one call and lands in memory", async () => {
		const agent = makeAgent();
		const res = await agent.ask("salut");

		expect(seen.length).toBe(1);
		expect(res.choices[0]?.message?.content).toBe("bonjour");
		expect(agent.history.map((t) => `${t.role}:${t.content}`)).toEqual(["user:salut", "assistant:bonjour"]);
	});

	test("runs the tool the model asked for, then answers", async () => {
		script = ["tool", "text"];
		let ran: unknown = null;
		const tool: Tool = {
			name: "echo_tool",
			description: "Echo the input back",
			parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
			invoker: async (args) => {
				ran = args;
				return { echoed: args.x };
			},
		};
		const agent = makeAgent([tool]);
		const res = await agent.ask("use the tool please");

		expect(seen.length).toBe(2);
		expect(ran).toEqual({ x: "hi" });
		expect(res.choices[0]?.message?.content).toBe("bonjour");
		// the second request must carry the tool result for the model
		const second = seen[1] as unknown as { messages: { role: string; role2?: string; tool_call_id?: string }[] };
		expect(second.messages.some((m) => m.role === "tool")).toBe(true);
	});

	test("the system prompt advertises the callable tools", async () => {
		const tool: Tool = {
			name: "echo_tool",
			description: "Echo the input back",
			parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
			invoker: async () => null,
		};
		const agent = makeAgent([tool]);
		await agent.ask("hi");

		const first = seen[0] as unknown as { messages: { role: string; content: string }[]; tools?: unknown[] };
		expect(first.messages[0].role).toBe("system");
		expect(first.messages[0].content).toContain("Tools you can call right now");
		expect(first.messages[0].content).toContain("- echo_tool(x): Echo the input back");
		expect(Array.isArray(first.tools)).toBe(true);
	});

	test("a filtered-out tool disappears from prompt and schema", async () => {
		const tool: Tool = {
			name: "echo_tool",
			description: "Echo the input back",
			parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
			invoker: async () => null,
		};
		const agent = makeAgent([tool]);
		agent.toolFilter = () => false;
		await agent.ask("hi");

		const first = seen[0] as unknown as { messages: { content: string }[]; tools?: unknown[] };
		expect(first.tools).toBeUndefined();
		expect(first.messages[0].content).toContain("no tools available");
		expect(first.messages[0].content).not.toContain("echo_tool");
	});

	test("ephemeral calls never touch the conversation memory", async () => {
		const agent = makeAgent();
		await agent.ask("internal generation", undefined, { ephemeral: true });
		expect(agent.history).toHaveLength(0);
	});
});
