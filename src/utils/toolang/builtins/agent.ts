/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// Agent module - wraps the Agent interface for TooLang

import type Agent from '../../../agent/struct.js';

class AgentError extends Error {
	constructor(message: string) {
		super(`Runtime error: ${message}`);
		this.name = 'RuntimeError';
	}
}

export function Agent(getAgent: () => Agent): Record<string, Function> {
	const requireModel = (agent: Agent, type: 'image' | 'video' | 'tts' | 'stt') => {
		// throws if the model isn't configured, so tools fail loudly instead of silently
		agent.getModel(type);
	};
	return {
		// every call here is an internal generation: ephemeral keeps it out of the
		// rolling conversation memory, and the forced model type picks the right one
		generate_text: async (prompt: string) => {
			const agent = getAgent();
			if (typeof prompt !== 'string' || prompt.length === 0) throw new AgentError('agent.generate_text expects a non-empty prompt');
			return await agent.ask(prompt, undefined, { ephemeral: true });
		},

		generate_image: async (prompt: string) => {
			const agent = getAgent();
			requireModel(agent, 'image');
			return await agent.ask(prompt, undefined, { ephemeral: true, model: 'image' });
		},

		generate_audio: async (prompt: string) => {
			const agent = getAgent();
			requireModel(agent, 'tts');
			return await agent.ask(prompt, undefined, { ephemeral: true, model: 'tts' });
		},

		generate_video: async (prompt: string) => {
			const agent = getAgent();
			requireModel(agent, 'video');
			return await agent.ask(prompt, undefined, { ephemeral: true, model: 'video' });
		},

		transcript: async (audioUrl: string) => {
			const agent = getAgent();
			requireModel(agent, 'stt');
			return await agent.ask(`Transcribe this audio: ${audioUrl}`, undefined, { ephemeral: true, model: 'stt' });
		},

		/**
		 * Rank documents against a query with the configured rerank model
		 * ([agent.models].rerank_model): POSTs to the provider's Cohere-style
		 * /rerank endpoint and returns [{ index, score }] best-first. Never
		 * runs a chat turn, never leaks the key, caps query/documents/response.
		 */
		rerank: async (query: unknown, documents: unknown) => {
			const agent = getAgent();
			const q = String(query ?? '').trim();
			if (q.length === 0 || q.length > 4_000) throw new AgentError('agent.rerank: query must be 1..4000 chars');
			if (!Array.isArray(documents)) throw new AgentError('agent.rerank: documents must be an array of strings');
			const docs = documents.slice(0, 100).map((d) => String(d).slice(0, 4_000));
			if (docs.length === 0) throw new AgentError('agent.rerank: documents must not be empty');
			// getModel falls back to the default chat model, so check the TYPE:
			// hitting a chat endpoint with /rerank would just 404 confusingly
			const model = agent.getModel('rerank');
			if (model.type !== 'rerank') throw new AgentError('agent.rerank: no rerank model configured ([agent.models].rerank_model)');
			const url = model.provider.baseUrl.replace(/\/+$/, '') + '/rerank';
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'authorization': `Bearer ${model.provider.apiKey}` },
				body: JSON.stringify({ model: model.name, query: q, documents: docs, top_n: docs.length }),
				signal: AbortSignal.timeout(30_000)
			});
			if (!res.ok) throw new AgentError(`agent.rerank: provider answered HTTP ${res.status}`);
			if (Number(res.headers.get('content-length') ?? 0) > 2_000_000) throw new AgentError('agent.rerank: response too large');
			let data: { results?: { index?: unknown; relevance_score?: unknown }[] };
			try {
				data = JSON.parse((await res.text()).slice(0, 2_000_000));
			} catch {
				throw new AgentError('agent.rerank: provider response is not JSON');
			}
			const results = (Array.isArray(data.results) ? data.results : [])
				.map((r) => ({ index: Math.floor(Number(r.index)), score: Number(r.relevance_score) }))
				.filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < docs.length && Number.isFinite(r.score))
				.sort((a, b) => b.score - a.score)
				.slice(0, 100);
			if (results.length === 0) throw new AgentError('agent.rerank: provider returned no usable results');
			return results;
		}
	};
}
