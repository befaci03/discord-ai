// agent.rerank: posts to the rerank model's Cohere-style /rerank endpoint,
// returns [{ index, score }] best-first, caps its inputs, and fails loudly
// when no rerank model is configured (instead of hitting the chat endpoint).

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runFromSource } from '../utils/toolang/index.js';
import type Agent from '../agent/struct.js';

let server: ReturnType<typeof Bun.serve>;
let seen: { body: Record<string, unknown>; auth: string | null }[] = [];

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			seen.push({ body: (await req.json()) as Record<string, unknown>, auth: req.headers.get('authorization') });
			return Response.json({
				results: [
					{ index: 1, relevance_score: 0.9 },
					{ index: 0, relevance_score: 0.2 }
				]
			});
		}
	});
});

afterAll(() => server.stop(true));

/** minimal Agent stand-in: only getModel is used by rerank */
function fakeAgent(modelType: 'rerank' | 'default'): Agent {
	return {
		status: { busy: false, doing: 'nothing much, just looking at messages', mode: 'idle' },
		getModel: () => ({
			type: modelType,
			name: modelType === 'rerank' ? 'rerank-v1' : 'chat-model',
			provider: { apiType: 1, baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'sk-fake-for-test' }
		}),
		ask: async () => {
			throw new Error('rerank must never start a chat turn');
		},
		useTool: async () => null
	} as unknown as Agent;
}

async function rerank(code: string, agent: Agent): Promise<{ ok: boolean; value?: unknown; error?: string }> {
	try {
		return { ok: true, value: await runFromSource(code, {}, { agent }) };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

describe('agent.rerank', () => {
	test('posts query+documents to the rerank endpoint and sorts best-first', async () => {
		seen = [];
		const res = await rerank('return(agent.rerank("best doc", ["meh", "winner"]))', fakeAgent('rerank'));
		expect(res.ok).toBe(true);
		expect(res.value).toEqual([
			{ index: 1, score: 0.9 },
			{ index: 0, score: 0.2 }
		]);
		expect(seen).toHaveLength(1);
		expect(seen[0].body.model).toBe('rerank-v1');
		expect(seen[0].body.query).toBe('best doc');
		expect(seen[0].body.documents).toEqual(['meh', 'winner']);
		// the key travels only in the auth header, never in the body
		expect(seen[0].auth).toBe('Bearer sk-fake-for-test');
		expect(JSON.stringify(seen[0].body)).not.toContain('sk-fake');
	});

	test('no rerank model configured fails loudly instead of using chat', async () => {
		seen = [];
		const res = await rerank('return(agent.rerank("q", ["a"]))', fakeAgent('default'));
		expect(res.ok).toBe(false);
		expect(res.error).toContain('no rerank model configured');
		expect(seen).toHaveLength(0); // nothing was posted anywhere
	});

	test('inputs are validated before any network call', async () => {
		seen = [];
		const agent = fakeAgent('rerank');
		expect((await rerank('return(agent.rerank("", ["a"]))', agent)).error).toContain('query must be');
		expect((await rerank('return(agent.rerank("q", "not-an-array"))', agent)).error).toContain('array of strings');
		expect((await rerank('return(agent.rerank("q", []))', agent)).error).toContain('must not be empty');
		expect(seen).toHaveLength(0);
	});
});
