// The name-mention gate is pure (text + name in, boolean out), so it lives in
// bot.ts as an exported helper and is tested here without a Discord client.
// The case it must never lose: an empty or junk name must not match, or
// answer_when_name_mention would answer every message in the server.

import { describe, test, expect } from 'bun:test';
import { mentionsName } from '../bot.js';

describe('mentionsName', () => {
	test('matches the name as its own word, case-insensitively', () => {
		expect(mentionsName('Hey Agent, ping', 'Agent')).toBe(true);
		expect(mentionsName('hey agent!', 'Agent')).toBe(true);
		expect(mentionsName('AGENT?', 'agent')).toBe(true);
		expect(mentionsName("bot's job", 'bot')).toBe(true);
		expect(mentionsName('bot,', 'bot')).toBe(true);
	});

	test('does not match inside a longer word', () => {
		expect(mentionsName('the agents gathered', 'Agent')).toBe(false);
		expect(mentionsName('a robot rolls', 'bot')).toBe(false);
		expect(mentionsName('cafetime', 'café')).toBe(false);
		expect(mentionsName('management', 'agent')).toBe(false);
	});

	test('empty names and empty texts never match', () => {
		expect(mentionsName('hello', '')).toBe(false);
		expect(mentionsName('hello', '   ')).toBe(false);
		expect(mentionsName('hello', undefined)).toBe(false);
		expect(mentionsName('', 'agent')).toBe(false);
		expect(mentionsName(undefined, undefined)).toBe(false);
	});

	test('regex metacharacters in the name are literal, not a pattern', () => {
		expect(mentionsName('a.b wins', 'a.b')).toBe(true);
		expect(mentionsName('axb wins', 'a.b')).toBe(false);
		expect(mentionsName('c(b) yes', 'c(b)')).toBe(true);
	});

	test('unicode names get unicode word boundaries', () => {
		expect(mentionsName('un café svp', 'café')).toBe(true);
		expect(mentionsName('café time', 'CAFÉ')).toBe(true);
	});
});
