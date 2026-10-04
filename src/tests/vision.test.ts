// Vision: Discord image attachments only leave this process as Discord-CDN
// https URLs, only reach a model that takes images, and arrive as proper
// image content parts (OpenAI image_url / Anthropic url source). A model
// without vision gets a plain text message instead: never a failed ask.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import OpenAIAgent from '../agent/openai.js';
import AnthropicAgent from '../agent/anthropic.js';
import { Model, Provider } from '../agent/struct.js';
import { supportsVision, pickImageUrls } from '../agent/vision.js';
import SQLiteDB from '../db/sqlite.js';
import { Logger } from '../utils/logger.js';

let dir: string;
let db: SQLiteDB;
let server: ReturnType<typeof Bun.serve>;
let provider: Provider;
/** which response shape the mock serves */
let mode: 'openai' | 'anthropic' = 'openai';
/** every request body the mock received */
let seen: Record<string, unknown>[] = [];

beforeAll(async () => {
	dir = mkdtempSync(path.join(tmpdir(), 'discord-ai-vision-'));
	db = new SQLiteDB(path.join(dir, 'vision.sqlite'));
	await db.init();
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			seen.push((await req.json()) as Record<string, unknown>);
			if (mode === 'anthropic') {
				return Response.json({
					id: 'msg_1',
					type: 'message',
					role: 'assistant',
					model: 'claude-test',
					content: [{ type: 'text', text: 'i see it' }],
					stop_reason: 'end_turn',
					usage: { input_tokens: 1, output_tokens: 1 }
				});
			}
			return Response.json({
				id: 'chatcmpl-1',
				object: 'chat.completion',
				created: 0,
				model: 'gpt-test',
				choices: [{ index: 0, message: { role: 'assistant', content: 'i see it' }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
			});
		}
	});
	provider = { apiType: 1, baseUrl: `http://127.0.0.1:${server.port}`, apiKey: 'sk-test' };
});

afterAll(async () => {
	server.stop(true);
	await db.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	seen = [];
	mode = 'openai';
});

function model(name: string, vision?: boolean): Model {
	return { type: 'default', provider, name, vision };
}

describe('supportsVision', () => {
	test('known vision families match, unknown ones do not', () => {
		expect(supportsVision('gpt-4o-mini')).toBe(true);
		expect(supportsVision('gpt-4.1')).toBe(true);
		expect(supportsVision('claude-sonnet-4-5')).toBe(true);
		expect(supportsVision('claude-3-5-haiku')).toBe(true);
		expect(supportsVision('gemini-2.0-flash')).toBe(true);
		expect(supportsVision('qwen2.5-vl-7b')).toBe(true);
		expect(supportsVision('my-gateway-vision')).toBe(true);
		expect(supportsVision('claude-2.1')).toBe(false);
		expect(supportsVision('llama-3.1-70b')).toBe(false);
		expect(supportsVision('')).toBe(false);
	});
});

describe('pickImageUrls', () => {
	const cdn = (path: string, type = 'image/png') => ({ url: `https://cdn.discordapp.com/attachments/1/${path}`, contentType: type });

	test('only https Discord-CDN image URLs survive, capped', () => {
		expect(pickImageUrls([cdn('a.png')])).toEqual(['https://cdn.discordapp.com/attachments/1/a.png']);
		// non-image, http, foreign host and junk are dropped
		expect(pickImageUrls([{ url: 'https://cdn.discordapp.com/attachments/1/a.mp4', contentType: 'video/mp4' }])).toEqual([]);
		expect(pickImageUrls([{ url: 'http://cdn.discordapp.com/attachments/1/a.png', contentType: 'image/png' }])).toEqual([]);
		expect(pickImageUrls([{ url: 'https://evil.example.com/a.png', contentType: 'image/png' }])).toEqual([]);
		expect(pickImageUrls([{ url: 'not a url', contentType: 'image/png' }])).toEqual([]);
		// cap: 4 by default
		const many = Array.from({ length: 6 }, (_, i) => cdn(`${i}.png`));
		expect(pickImageUrls(many)).toHaveLength(4);
		expect(pickImageUrls(many, 2)).toHaveLength(2);
	});
});

describe('image attachments reach the provider', () => {
	test('openai: a vision model gets image_url parts in the user message', async () => {
		const agent = new OpenAIAgent(db, provider, [model('gpt-4o-mini', true)], 'You are a test agent.', [], 4, new Logger('error'));
		const url = 'https://cdn.discordapp.com/attachments/1/x.png';
		const res = await agent.ask('what is this?', undefined, { images: [url] });
		expect(res.choices[0]?.message?.content).toBe('i see it');
		expect(seen).toHaveLength(1);
		const messages = seen[0].messages as { role: string; content: unknown }[];
		const user = messages[messages.length - 1];
		expect(user.role).toBe('user');
		expect(Array.isArray(user.content)).toBe(true);
		const parts = user.content as { type: string; text?: string; image_url?: { url: string } }[];
		expect(parts[0]).toEqual({ type: 'text', text: 'what is this?' });
		expect(parts[1]).toEqual({ type: 'image_url', image_url: { url } });
	});

	test('openai: a model without vision gets plain text (images dropped, ask never fails)', async () => {
		const agent = new OpenAIAgent(db, provider, [model('llama-3.1-70b', false)], 'You are a test agent.', [], 4, new Logger('error'));
		const res = await agent.ask('what is this?', undefined, { images: ['https://cdn.discordapp.com/attachments/1/x.png'] });
		expect(res.choices[0]?.message?.content).toBe('i see it');
		const messages = seen[0].messages as { role: string; content: unknown }[];
		expect(messages[messages.length - 1].content).toBe('what is this?');
	});

	test('anthropic: the prompt message carries image url blocks', async () => {
		mode = 'anthropic';
		const agent = new AnthropicAgent(db, { ...provider, apiType: 0 }, [model('claude-sonnet-4-5', true)], 'You are a test agent.', [], 4, new Logger('error'));
		const url = 'https://cdn.discordapp.com/attachments/1/y.jpg';
		const res = await agent.ask('describe', undefined, { images: [url] });
		expect(res.choices[0]?.message?.content).toBe('i see it');
		const messages = seen[0].messages as { role: string; content: unknown }[];
		expect(messages).toHaveLength(1);
		const parts = messages[0].content as { type: string; text?: string; source?: { type: string; url: string } }[];
		expect(parts[0]).toEqual({ type: 'text', text: 'describe' });
		expect(parts[1]).toEqual({ type: 'image', source: { type: 'url', url } });
	});

	test('anthropic: a model without vision stays a plain string', async () => {
		mode = 'anthropic';
		const agent = new AnthropicAgent(db, { ...provider, apiType: 0 }, [model('claude-2.1', false)], 'You are a test agent.', [], 4, new Logger('error'));
		await agent.ask('describe', undefined, { images: ['https://cdn.discordapp.com/attachments/1/y.jpg'] });
		const messages = seen[0].messages as { role: string; content: unknown }[];
		expect(messages[0].content).toBe('describe');
	});
});
