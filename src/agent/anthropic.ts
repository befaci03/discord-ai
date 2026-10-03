// uses @anthropic-ai/sdk

import { Anthropic } from "@anthropic-ai/sdk";
import { ChatCompletion } from "openai/resources.mjs";
import DB from "../db/struct.js";
import Agent, { Brain, AgentStatus, Provider, Model, ModelType, Tool } from "./struct.js";
import { Logger } from "../utils/logger.js";
import { ExternalError } from "../utils/errors.js";

/** Anthropic-flavoured agent exposing the same interface as the OpenAI one. */
export default class extends Brain implements Agent {
	private prov: Anthropic;
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
		this.prov = new Anthropic({ apiKey: api.apiKey, baseURL: api.baseUrl || undefined });
		this.status = { busy: false, doing: "nothing much, just looking at messages", mode: "idle" };
		this.log = (log ?? new Logger()).child("agent.anthropic");
	}

	/**
	 * ask() adapts Anthropic's Message API to the ChatCompletion shape the rest
	 * of the project expects, so callers stay provider-agnostic.
	 */
	public async ask(prompt: string, system?: string): Promise<ChatCompletion> {
		this.status = { ...this.status, busy: true, doing: "thinking" };
		try {
			const response = await this.prov.messages.create({
				model: this.models[0].name,
				max_tokens: 2048,
				system: this.sys_prompt + (system ?? ""),
				messages: [{ role: "user", content: prompt }],
				tools: this.tools.length > 0
					? this.tools.map((t) => ({
						name: t.name,
						description: t.description,
						input_schema: (t.parameters ?? { type: "object", properties: {} }) as { type: "object"; properties: Record<string, unknown> },
					}))
					: undefined,
			});

			const text = response.content
				.filter((b): b is Anthropic.ContentBlock & { text: string } => "text" in b)
				.map((b) => b.text)
				.join("\n");

			// shape-shift into a ChatCompletion-ish object so downstream code works
			return {
				id: response.id,
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model: response.model,
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: text },
						finish_reason: response.stop_reason === "max_tokens" ? "length" : "stop",
					},
				],
				usage: {
					prompt_tokens: response.usage.input_tokens,
					completion_tokens: response.usage.output_tokens,
					total_tokens: response.usage.input_tokens + response.usage.output_tokens,
				},
			} as unknown as ChatCompletion;
		} catch (err) {
			this.log.error("ask failed:", err instanceof Error ? err.message : err);
			throw new ExternalError("anthropic", err);
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
