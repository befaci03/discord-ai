// Fake tool calls typed into a reply instead of being called: they must be
// detected and stripped before the message reaches Discord, while legitimate
// prose (lists, "next steps: ...") survives untouched.

import { describe, test, expect } from 'bun:test';
import { detectFakeToolCalls, stripFakeToolCalls } from '../agent/fakecalls.js';

/** the private-use delimiter models emit around fake calls (U+E200 here) */
const PUA = '\uE200';
const known = (n: string): boolean => ['docker_exec', 'sandbox_write', 'docker_cp'].includes(n);

describe('fake tool call detection', () => {
	test('markup lines with private-use tags are found and stripped', () => {
		const reply = ["c'est carré", `${PUA}docker_cp`, '<arg_key>container</arg_key>', '<arg_value>nginx-srv</arg_value>', `${PUA}`, 'next?'].join('\n');
		expect(detectFakeToolCalls(reply, known)).toEqual(['docker_cp', '<arg markup>']);
		expect(stripFakeToolCalls(reply, known)).toBe("c'est carré\nnext?");
	});

	test('an unclosed fake call at the end still gets detected and stripped', () => {
		const reply = ["j'injecte l'index", `${PUA}docker cp`, '<arg_key>source</arg_key>', '<arg_value>index.html</arg_value>'].join('\n');
		expect(detectFakeToolCalls(reply, known)).toEqual(['docker', '<arg markup>']);
		expect(stripFakeToolCalls(reply, known)).toBe("j'injecte l'index");
	});

	test('arg tag lines without a delimiter are still markup', () => {
		const reply = ['ok', '<arg_key>container</arg_key>', '<arg_value>web</arg_value>', "c'est bon"].join('\n');
		expect(detectFakeToolCalls(reply, known)).toEqual(['<arg markup>']);
		expect(stripFakeToolCalls(reply, known)).toBe("ok\nc'est bon");
	});

	test('a typed call line for a REAL tool is stripped', () => {
		const reply = ['go', 'docker_exec container: nginx-srv command: ls -la /usr/share/nginx', 'done'].join('\n');
		expect(detectFakeToolCalls(reply, known)).toEqual(['docker_exec']);
		expect(stripFakeToolCalls(reply, known)).toBe('go\ndone');
	});

	test('prose that merely looks listy is never stripped', () => {
		const prose = ['next steps: fix the port, retry: tomorrow', 'note: see above', 'caddy: https://x trycloudflare.com'].join('\n');
		expect(detectFakeToolCalls(prose, known)).toEqual([]);
		expect(stripFakeToolCalls(prose, known)).toBe(prose);
	});

	test('an unknown tool name needs three key: pairs to count', () => {
		const weak = 'some_random_thing key: value';
		expect(detectFakeToolCalls(weak)).toEqual([]);
		expect(stripFakeToolCalls(weak)).toBe(weak);
		const strong = 'ghost_tool container: a source: b destination: c';
		expect(detectFakeToolCalls(strong)).toEqual(['ghost_tool']);
		expect(stripFakeToolCalls(strong)).toBe('');
	});

	test('a clean reply comes back byte-identical (no surprise trimming)', () => {
		const clean = "c'est carré, caddy sur https://xxx, nginx derrière. next?";
		expect(detectFakeToolCalls(clean, known)).toEqual([]);
		expect(stripFakeToolCalls(clean, known)).toBe(clean);
	});
});
