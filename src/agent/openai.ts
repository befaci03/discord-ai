// uses openai

import { OpenAI } from 'openai';
import { ChatCompletion, ChatCompletionMessageParam, ChatCompletionContentPart } from 'openai/resources';
import DB from '../db/struct.js';
import Agent, { AskOptions, Brain, Provider, Model, ModelType, Tool } from './struct.js';
import { Logger } from '../utils/logger.js';
import { ExternalError } from '../utils/errors.js';

export default class extends Brain implements Agent {
	private prov: OpenAI;
	private log: Logger;

	constructor(
		db: DB,
		api: Provider,
		private models: Model[],
		public sys_prompt: string,
		tools: Tool[] = [],
		private maxToolRoundtrips = 16,
		log?: Logger,
		/** [agent].max_tokens: 0 = leave the output cap to the provider */
		private maxOutputTokens = 0,
		/** [agent].tool_calls_per_round: how many calls run per round (1..15) */
		private maxCallsPerRound = 10
	) {
		super(db, tools);
		this.prov = new OpenAI({ apiKey: api.apiKey, baseURL: api.baseUrl || undefined });
		this.log = (log ?? new Logger()).child('agent.openai');
	}

	public async ask(prompt: string, system?: string, opts?: AskOptions): Promise<ChatCompletion> {
		this.setStatus({ busy: true, doing: 'thinking' });
		try {
			// internal calls (agent.generate_*) leave the conversation memory alone
			const ephemeral = opts?.ephemeral === true;
			if (!ephemeral) await this.ensureMemory();
			const model = this.getModel(this.routeModel(prompt, opts?.model));
			// surface what the agent is doing on the dashboard (talking vs coding)
			this.setStatus({ busy: true, doing: 'thinking', mode: model.type === 'coding' ? 'coding' : 'talking' });
			const suffix = ephemeral ? '' : await this.contextSuffix(opts?.speakerId);
			// identity + brain + tool inventory, then the situational context
			const base = this.sys_prompt + suffix + this.toolsBlock();
			const history: ChatCompletionMessageParam[] = ephemeral ? [] : this.historyMessages().map((t) => ({ role: t.role, content: t.content }) as ChatCompletionMessageParam);
			// images ride along only when the CHOSEN model takes image input;
			// otherwise they are dropped (never a reason to fail the whole ask)
			const images = opts?.images?.length ? opts.images : [];
			if (images.length > 0 && model.vision !== true) {
				this.log.info(`dropping ${images.length} image attachment(s): model '${model.name}' has no vision`);
			}
			const userContent: string | ChatCompletionContentPart[] =
				images.length > 0 && model.vision === true ? [{ type: 'text', text: prompt }, ...images.map((u) => ({ type: 'image_url' as const, image_url: { url: u } }))] : prompt;
			const messages: ChatCompletionMessageParam[] = [{ role: 'system', content: base + (system ?? '') }, ...history, { role: 'user', content: userContent }];

			// tool loop: let the model call our tools, feed results back, repeat
			// (only tools that are still enabled: toggles apply immediately)
			const callable = this.callableTools();
			let final: ChatCompletion | null = null;
			for (let round = 0; round <= this.maxToolRoundtrips; round++) {
				const response = await this.prov.chat.completions.create({
					messages,
					model: model.name,
					// 0 = provider default: some gateways/models reject max_tokens,
					// so it is only sent when the operator asked for a cap
					max_tokens: this.maxOutputTokens > 0 ? this.maxOutputTokens : undefined,
					// explicit auto: some OpenAI-compatible gateways skip the tool
					// schema entirely when tool_choice is left out
					tool_choice: callable.length > 0 ? 'auto' : undefined,
					tools:
						callable.length > 0
							? callable.map((t) => ({
									type: 'function' as const,
									function: {
										name: t.name,
										description: t.description,
										parameters: t.parameters ?? { type: 'object', properties: {}, required: [] }
									}
								}))
							: undefined
				});

				const choice = response.choices[0]?.message;
				if (!choice?.tool_calls || choice.tool_calls.length === 0) {
					final = response;
					break;
				}

				// per-round call budget [agent].tool_calls_per_round: the first N
				// run, the rest get a "deferred" answer (every id must be answered)
				// so the model re-issues them next round instead of losing them
				const cap = Math.min(Math.max(this.maxCallsPerRound, 1), 15);
				const runnable = choice.tool_calls.slice(0, cap);
				const deferred = choice.tool_calls.slice(cap);

				// progress hook (Discord "Executing ..." message): per round, before
				// the calls run, and never allowed to break the tool loop
				try {
					opts?.onToolCall?.(runnable.filter((c) => c.type === 'function').map((c) => c.function.name));
				} catch {
					/* a broken progress hook must not eat the answer */
				}

				messages.push(choice);
				for (const call of runnable) {
					if (call.type !== 'function') continue;
					const tool = callable.find((t) => t.name === call.function.name);
					let content: string;
					try {
						if (!tool) throw new Error(`unknown tool ${call.function.name}`);
						const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
						const result = await this.useTool(tool, args);
						content = this.toolResultText(result);
					} catch (err) {
						content = this.toolResultText({ error: err instanceof Error ? err.message : String(err) });
					}
					messages.push({ role: 'tool', tool_call_id: call.id, content });
				}
				for (const call of deferred) {
					if (call.type !== 'function') continue;
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						content: this.toolResultText({ deferred: `per-round call budget (${cap} executed of ${choice.tool_calls.length}): re-issue this call in your next round` })
					});
				}
			}
			// budget exhausted without a text answer: one last call, tools removed,
			// so the model is forced to answer. Runs only when the loop never
			// produced a final response (otherwise we would burn a second call and
			// discard the answer the model already gave).
			if (final === null) {
				final = await this.prov.chat.completions.create({ messages, model: model.name });
			}

			// remember the exchange as a user+assistant pair so history stays alternating
			if (!ephemeral) {
				this.rememberTurn('user', prompt);
				this.rememberTurn('assistant', final.choices[0]?.message?.content ?? '');
			}
			return final;
		} catch (err) {
			this.log.error('ask failed:', err instanceof Error ? err.message : err);
			throw new ExternalError('openai', err);
		} finally {
			this.setStatus({ busy: false, doing: 'nothing much, just looking at messages', mode: 'idle' });
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
