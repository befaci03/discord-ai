// uses openai

import { OpenAI } from "openai";
import { ChatCompletion, ChatCompletionMessageParam } from "openai/resources";
import DB from "../db/struct.js";
import Agent, { Brain, AgentStatus, Provider, Model, ModelType, Tool } from "./struct.js";
import { Logger } from "../utils/logger.js";
import { ExternalError } from "../utils/errors.js";

export default class extends Brain implements Agent {
	private prov: OpenAI;
	public status: AgentStatus;
	private log: Logger;

	constructor(
		db: DB,
		api: Provider,
		private models: Model[],
		public sys_prompt: string,
		private tools: Tool[] = [],
		private maxToolRoundtrips = 4,
		log?: Logger,
	) {
		super(db);
		this.prov = new OpenAI({ apiKey: api.apiKey, baseURL: api.baseUrl || undefined });
		this.status = { busy: false, doing: "nothing much, just looking at messages", mode: "idle" };
		this.log = (log ?? new Logger()).child("agent.openai");
	}

	public async ask(prompt: string, system?: string): Promise<ChatCompletion> {
		this.status = { ...this.status, busy: true, doing: "thinking" };
		try {
			const messages: ChatCompletionMessageParam[] = [
				{ role: "system", content: this.sys_prompt + (system ?? "") },
				{ role: "user", content: prompt },
			];

			// tool loop: let the model call our tools, feed results back, repeat
			for (let round = 0; round <= this.maxToolRoundtrips; round++) {
				const response = await this.prov.chat.completions.create({
					messages,
					model: this.models[0].name,
					tools: this.tools.length > 0
						? this.tools.map((t) => ({
							type: "function" as const,
							function: {
								name: t.name,
								description: t.description,
								parameters: t.parameters ?? { type: "object", properties: {}, required: [] },
							},
						}))
						: undefined,
				});

				const choice = response.choices[0]?.message;
				if (!choice?.tool_calls || choice.tool_calls.length === 0) return response;

				messages.push(choice);
				for (const call of choice.tool_calls) {
					if (call.type !== "function") continue;
					const tool = this.tools.find((t) => t.name === call.function.name);
					let content: string;
					try {
						if (!tool) throw new Error(`unknown tool ${call.function.name}`);
						const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
						const result = await this.useTool(tool, args);
						content = JSON.stringify(result) ?? "ok";
					} catch (err) {
						content = JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) ?? "error";
					}
					messages.push({ role: "tool", tool_call_id: call.id, content });
				}
			}
			// budget exhausted: final answer without tools
			return await this.prov.chat.completions.create({ messages, model: this.models[0].name });
		} catch (err) {
			this.log.error("ask failed:", err instanceof Error ? err.message : err);
			throw new ExternalError("openai", err);
		} finally {
			this.status = { busy: false, doing: "nothing much, just looking at messages", mode: this.status.mode };
		}
	}

	public async useTool(tool: Tool, args: unknown): Promise<unknown> {
		return await tool.invoker(args as Record<string, unknown>);
	}

	public getModel(type: ModelType): Model {
		// fall back to the default model when no dedicated one is configured
		return this.models.find((m) => m.type === type) ?? this.models[0];
	}
}
