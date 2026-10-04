// uses @anthropic-ai/sdk

import { Anthropic } from '@anthropic-ai/sdk';
import { ChatCompletion } from 'openai/resources.mjs';
import DB from '../db/struct.js';
import Agent, { AskOptions, Brain, Provider, Model, ModelType, Tool } from './struct.js';
import { Logger } from '../utils/logger.js';
import { ExternalError } from '../utils/errors.js';

/** Anthropic-flavoured agent exposing the same interface as the OpenAI one. */
export default class extends Brain implements Agent {
	private prov: Anthropic;
	private log: Logger;

	constructor(
		db: DB,
		api: Provider,
		private models: Model[],
		public sys_prompt: string,
		tools: Tool[] = [],
		private maxToolRoundtrips = 16,
		log?: Logger,
		/** [agent].max_tokens: 0 = fall back to the API-safe default below */
		private maxOutputTokens = 0
	) {
		super(db, tools);
		this.prov = new Anthropic({ apiKey: api.apiKey, baseURL: api.baseUrl || undefined });
		this.log = (log ?? new Logger()).child('agent.anthropic');
	}

	/**
	 * ask() adapts Anthropic's Message API to the ChatCompletion shape the rest
	 * of the project expects, so callers stay provider-agnostic.
	 */
	public async ask(prompt: string, system?: string, opts?: AskOptions): Promise<ChatCompletion> {
		this.setStatus({ busy: true, doing: 'thinking' });
		try {
			const ephemeral = opts?.ephemeral === true;
			if (!ephemeral) await this.ensureMemory();
			const model = this.getModel(this.routeModel(prompt, opts?.model));
			this.setStatus({ busy: true, doing: 'thinking', mode: model.type === 'coding' ? 'coding' : 'talking' });
			const suffix = ephemeral ? '' : await this.contextSuffix(opts?.speakerId);
			// identity + brain + tool inventory, then the situational context
			const systemPrompt = this.sys_prompt + suffix + this.toolsBlock() + (system ?? '');
			const messages: Anthropic.MessageParam[] = ephemeral ? [{ role: 'user', content: prompt }] : this.mergeTurns([...this.historyMessages(), { role: 'user', content: prompt }]);
			// only tools that are still enabled: dashboard toggles apply immediately
			const callable = this.callableTools();
			let toolsDef =
				callable.length > 0
					? callable.map((t) => ({
							name: t.name,
							description: t.description,
							input_schema: (t.parameters ?? { type: 'object', properties: {} }) as { type: 'object'; properties: Record<string, unknown> }
						}))
					: undefined;

			// anthropic requires an explicit number; 4096 is the floor that keeps
			// a tool-heavy turn (args + result + answer) from truncating mid-call
			const send = () =>
				this.prov.messages.create({
					model: model.name,
					max_tokens: this.maxOutputTokens > 0 ? this.maxOutputTokens : 4096,
					system: systemPrompt,
					messages,
					tools: toolsDef,
					tool_choice: toolsDef ? { type: 'auto' } : undefined
				});
			let response = await send();

			// Tool loop: without it the model could ask for a tool and still answer
			// the user with nothing at all (the OpenAI agent already had one).
			for (let round = 0; round <= this.maxToolRoundtrips; round++) {
				const toolUses = response.content.filter((b) => b.type === 'tool_use') as Anthropic.ToolUseBlock[];
				if (toolUses.length === 0) break;
				// progress hook (Discord "Executing ..." message), same rules as openai.ts
				try {
					opts?.onToolCall?.(toolUses.map((u) => u.name));
				} catch {
					/* a broken progress hook must not eat the answer */
				}
				messages.push({ role: 'assistant', content: response.content });
				const results: { type: 'tool_result'; tool_use_id: string; content: string }[] = [];
				for (const use of toolUses) {
					let out: string;
					try {
						const tool = callable.find((t) => t.name === use.name);
						if (!tool) throw new Error(`unknown tool ${use.name}`);
						const result = await this.useTool(tool, (use.input ?? {}) as Record<string, unknown>);
						out = this.toolResultText(result);
					} catch (err) {
						out = this.toolResultText({ error: err instanceof Error ? err.message : String(err) });
					}
					results.push({ type: 'tool_result', tool_use_id: use.id, content: out });
				}
				messages.push({ role: 'user', content: results });
				// the final roundtrips drop the tools, so the model must answer in text
				if (round >= this.maxToolRoundtrips) toolsDef = undefined;
				response = await send();
			}

			const text = response.content
				.filter((b): b is Anthropic.ContentBlock & { text: string } => 'text' in b)
				.map((b) => b.text)
				.join('\n');

			// keep the rolling memory in sync (pairs stay alternating for the API)
			if (!ephemeral) {
				this.rememberTurn('user', prompt);
				this.rememberTurn('assistant', text);
			}

			// shape-shift into a ChatCompletion-ish object so downstream code works
			return {
				id: response.id,
				object: 'chat.completion',
				created: Math.floor(Date.now() / 1000),
				model: response.model,
				choices: [
					{
						index: 0,
						message: { role: 'assistant', content: text },
						finish_reason: response.stop_reason === 'max_tokens' ? 'length' : 'stop'
					}
				],
				usage: {
					prompt_tokens: response.usage.input_tokens,
					completion_tokens: response.usage.output_tokens,
					total_tokens: response.usage.input_tokens + response.usage.output_tokens
				}
			} as unknown as ChatCompletion;
		} catch (err) {
			this.log.error('ask failed:', err instanceof Error ? err.message : err);
			throw new ExternalError('anthropic', err);
		} finally {
			this.setStatus({ busy: false, doing: 'nothing much, just looking at messages', mode: 'idle' });
		}
	}

	public async useTool(tool: Tool, args: unknown): Promise<unknown> {
		return await tool.invoker(args as Record<string, unknown>);
	}

	/**
	 * Anthropic wants strict user/assistant alternation, so consecutive turns
	 * of the same role (possible after a partial history) get merged.
	 */
	private mergeTurns(turns: { role: 'user' | 'assistant'; content: string }[]): Anthropic.MessageParam[] {
		const merged: { role: 'user' | 'assistant'; content: string }[] = [];
		for (const t of turns) {
			if (!t.content.trim()) continue;
			const last = merged[merged.length - 1];
			if (last && last.role === t.role) last.content += '\n' + t.content;
			else merged.push({ role: t.role, content: t.content });
		}
		while (merged.length > 0 && merged[0].role === 'assistant') merged.shift();
		return merged;
	}

	public getModel(type: ModelType): Model {
		// fall back to the default model when no dedicated one is configured
		return this.models.find((m) => m.type === type) ?? this.models[0];
	}
}
