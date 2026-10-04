// Brain: rolling memory, model routing, [agent.brain] seeding and reset.
// Every test gets its own sqlite file so kv state never leaks between them.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import SQLiteDB from '../db/sqlite.js';
import { Brain, MEMORY_DEFAULT, looksLikeCode, Tool } from '../agent/struct.js';

let dir: string;
const opened: SQLiteDB[] = [];
let counter = 0;

/** Fresh database file per test: brains persist state, tests must not share it. */
async function freshDb(): Promise<SQLiteDB> {
	const db = new SQLiteDB(path.join(dir, `brain-${counter++}.sqlite`));
	await db.init();
	opened.push(db);
	return db;
}

beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'discord-ai-brain-'));
});

afterAll(async () => {
	for (const db of opened) await db.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('model routing', () => {
	test('code-looking prompts are detected', () => {
		expect(looksLikeCode('```ts\nconst x = 1;\n```')).toBe(true);
		expect(looksLikeCode('fn main() { println!(1); }')).toBe(true);
		expect(looksLikeCode('def hello(name):')).toBe(true);
		expect(looksLikeCode('console.log(1)')).toBe(true);
	});

	test('plain chat is not code', () => {
		expect(looksLikeCode('yo what time is it in marseille?')).toBe(false);
		expect(looksLikeCode('tell me about the server rules')).toBe(false);
	});

	test('routeModel: code goes coding, an explicit choice always wins', async () => {
		const brain = new Brain(await freshDb());
		expect(brain.routeModel('hello')).toBe('default');
		expect(brain.routeModel('fix this ```rust\nfn main() {}\n```')).toBe('coding');
		expect(brain.routeModel('```rust\nfn main() {}\n```', 'default')).toBe('default');
	});
});

describe('rolling memory', () => {
	test('remembers MEMORY_DEFAULT turns and drops the oldest', async () => {
		const brain = new Brain(await freshDb());
		expect(brain.maxMemory).toBe(MEMORY_DEFAULT);
		for (let i = 0; i < MEMORY_DEFAULT + 10; i++) brain.rememberTurn('user', `msg ${i}`);
		expect(brain.history).toHaveLength(MEMORY_DEFAULT);
		expect(brain.history[0].content).toBe('msg 10');
	});

	test('memory = 0 means no memory at all', async () => {
		const brain = new Brain(await freshDb());
		brain.maxMemory = 0;
		await brain.ensureMemory();
		brain.rememberTurn('user', 'hi');
		brain.rememberTurn('assistant', 'hey');
		expect(brain.history).toHaveLength(0);
		expect(brain.historyMessages()).toHaveLength(0);
	});

	test('bootstraps saved chats, capped, never starting on an assistant turn', async () => {
		const db = await freshDb();
		for (let i = 0; i < 5; i++) {
			await db.recordChat({ author_id: 'u1', username: 'x', guild_id: 'g1', content: `q${i}`, response: `a${i}` });
		}
		const brain = new Brain(db);
		brain.maxMemory = 4;
		await brain.ensureMemory();
		expect(brain.history).toHaveLength(4);
		expect(brain.history[0]).toEqual({ role: 'user', content: 'q3' });
		expect(brain.historyMessages()[0].role).toBe('user');
	});

	test('ensureMemory bootstraps once, not per call', async () => {
		const brain = new Brain(await freshDb());
		brain.rememberTurn('user', 'kept');
		await brain.ensureMemory();
		await brain.ensureMemory();
		expect(brain.history.map((t) => t.content)).toEqual(['kept']);
	});
});

describe('[agent.brain] seeding', () => {
	test('tastes come from the seed when nothing is saved yet, then persist', async () => {
		const db = await freshDb();
		const brain = new Brain(db);
		brain.seed = { likes: ['rust'], dislikes: ['php'] };
		const suffix = await brain.contextSuffix();
		expect(suffix).toContain('you like: rust');
		expect(suffix).toContain('you dislike: php');

		// a new instance on the same DB finds the saved state
		const later = new Brain(db);
		expect(await later.contextSuffix()).toContain('you like: rust');
	});

	test('runtime edits beat the seed', async () => {
		const db = await freshDb();
		const brain = new Brain(db);
		brain.seed = { likes: ['rust'] };
		await brain.ensureMemory();
		await brain.setPreference('dislike', 'rust');
		const suffix = await brain.contextSuffix();
		expect(suffix).toContain('you dislike: rust');
		expect(suffix).not.toContain('you like: rust');
	});

	test('setPreference rejects unknown actions and empty targets', async () => {
		const brain = new Brain(await freshDb());
		let err = '';
		try {
			await brain.setPreference('meh', 'rust');
		} catch (e) {
			err = (e as Error).message;
		}
		expect(err).toContain('like|dislike|favorite|neutral');
	});

	test('brain.reset wipes saved state and re-seeds from config', async () => {
		const db = await freshDb();
		const first = new Brain(db);
		first.seed = { likes: ['rust'] };
		await first.ensureMemory();
		await first.setPreference('favorite', 'php');
		await first.rememberPerson('123456789012345678', { description: 'old friend' });

		const fresh = new Brain(db);
		fresh.seed = { likes: ['rust'] };
		fresh.reseed = true;
		await fresh.ensureMemory();
		const suffix = await fresh.contextSuffix();
		expect(suffix).toContain('you like: rust');
		expect(suffix).not.toContain('php');
		expect((await fresh.getPerson('123456789012345678')).description).toBe('');
	});
});

describe('tool inventory in the prompt', () => {
	const tools: Tool[] = [
		{
			name: 'fetch_json',
			description: 'Fetch a URL and parse the response as JSON',
			parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
			invoker: async () => null
		},
		{ name: 'server_stats', description: 'Overview of the server', invoker: async () => null }
	];

	test('lists every callable tool with its arguments', async () => {
		const brain = new Brain(await freshDb(), tools);
		const block = brain.toolsBlock();
		expect(block).toContain('### Tools you can call right now');
		// typed signatures: a bare name list gave no clue which arg is a string
		expect(block).toContain('- fetch_json(url: str): Fetch a URL');
		expect(block).toContain('- server_stats(): Overview');
		expect(block).toContain('never hand-write code for something a tool already does');
		expect(block).toContain('fix the arguments and call it again');
		// a call typed into the chat is text, not execution
		expect(block).toContain('A call typed out as text is not a call');
		expect(block).toContain('never report a result for a tool you have not actually called');
	});

	test('an empty toolbox says so instead of pretending', async () => {
		const block = new Brain(await freshDb()).toolsBlock();
		expect(block).toContain('no tools available');
	});

	test('the runtime filter drops toggled-off tools from the block', async () => {
		const brain = new Brain(await freshDb(), tools);
		brain.toolFilter = (name) => name !== 'fetch_json';
		const block = brain.toolsBlock();
		expect(block).not.toContain('fetch_json');
		expect(block).toContain('server_stats');
	});
});

describe('people profiles', () => {
	test('seeded people are known before the agent ever meets them', async () => {
		const brain = new Brain(await freshDb());
		brain.seed = { people: { '123456789012345678': { description: 'server owner', likes: ['football'] } } };
		const person = await brain.getPerson('123456789012345678');
		expect(person.description).toBe('server owner');
		expect(person.likes).toContain('football');
		const suffix = await brain.contextSuffix('123456789012345678');
		expect(suffix).toContain('Background on 123456789012345678');
	});

	test('rememberPerson persists, splits comma lists and validates ids', async () => {
		const db = await freshDb();
		const brain = new Brain(db);
		const saved = await brain.rememberPerson('999888777666', { description: 'new friend', likes: 'coffee, toast' });
		expect(saved.likes).toEqual(['coffee', 'toast']);

		const later = new Brain(db);
		expect((await later.getPerson('999888777666')).description).toBe('new friend');

		let err = '';
		try {
			await brain.rememberPerson('not-an-id', { description: 'x' });
		} catch (e) {
			err = (e as Error).message;
		}
		expect(err).toContain('numeric Discord user id');
	});
});
