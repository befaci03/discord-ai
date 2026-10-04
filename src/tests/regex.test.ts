// The regex builtin: useful match/replace power WITH the ReDoS guards, since
// patterns come from the model (untrusted-ish) and JS cannot interrupt a
// running match.

import { describe, test, expect } from 'bun:test';
import { runFromSource } from '../utils/toolang/index.js';

async function run(code: string): Promise<{ ok: boolean; value?: unknown; error?: string }> {
	try {
		return { ok: true, value: await runFromSource(code, {}) };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

describe('regex builtin', () => {
	test('test/match/matchAll/replace cover the everyday cases', async () => {
		// patterns avoid backslashes on purpose: a .tl string literal eats
		// unknown escapes (\w -> w), tool ARG json keeps them
		expect(await run('return(regex.test("a+", "bbb aaa"))')).toEqual({ ok: true, value: true });
		expect(await run('return(regex.test("A", "abc", "i"))')).toEqual({ ok: true, value: true });
		expect(await run('return(regex.test("z", "abc"))')).toEqual({ ok: true, value: false });

		const hit = await run('return(regex.match("[a-z]+@[a-z]+", "mail bob@home now").match)');
		expect(hit).toEqual({ ok: true, value: 'bob@home' });
		const groups = await run('set var m to regex.match("([a-z]+)@[a-z]+", "mail bob@home now")\nreturn(m.groups[0])');
		expect(groups).toEqual({ ok: true, value: 'bob' });

		const all = await run('return(regex.matchAll("[0-9]+", "a1 b22 c333").length())');
		expect(all).toEqual({ ok: true, value: 3 });

		const swapped = await run('return(regex.replace("([0-9]+)", "a1b22", "[$1]"))');
		expect(swapped).toEqual({ ok: true, value: 'a[1]b[22]' });

		const miss = await run('return(regex.match("zzz", "abc"))');
		expect(miss).toEqual({ ok: true, value: null });
	});

	test('matchAll implies /g instead of looping on one position', async () => {
		const res = await run('return(regex.matchAll("a", "aaa", "i").length())');
		expect(res).toEqual({ ok: true, value: 3 });
	});

	test('patterns that backtrack exponentially are refused with a rewrite hint', async () => {
		const nested = await run('return(regex.test("(a+)+$", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!"))');
		expect(nested.ok).toBe(false);
		expect(nested.error).toContain('backtracks exponentially');

		for (const bad of ['(a*)*', '(a|aa)+', '([0-9]+)+b', '(a(b+))+']) {
			const res = await run(`return(regex.test("${bad}", "x"))`);
			expect(res.ok, `pattern ${bad} must be refused`).toBe(false);
			expect(res.error).toContain('backtracks exponentially');
		}
		// safe shapes still work: plain quantifiers, unquantified groups
		expect(await run('return(regex.test("^[0-9]{1,3}$", "123"))')).toEqual({ ok: true, value: true });
		expect(await run('return(regex.test("(abc)+", "abcabc"))')).toEqual({ ok: true, value: true });
	});

	test('length caps, flags and compile errors all fail loudly', async () => {
		const longPattern = await run(`return(regex.test("${'a'.repeat(301)}", "x"))`);
		expect(longPattern.error).toContain('pattern must be 1..300');

		const badFlag = await run('return(regex.test("a", "a", "q"))');
		expect(badFlag.error).toContain("unknown flag 'q'");

		const broken = await run('return(regex.test("(", "a"))');
		expect(broken.error).toContain('invalid pattern');

		const empty = await run('return(regex.test("", "a"))');
		expect(empty.ok).toBe(false);

		const longText = await run(`return(regex.test("a", "${'x'.repeat(50_001)}"))`);
		expect(longText.error).toContain('text too long');
	});

	test('matchAll stops at the match cap instead of exploding', async () => {
		// 2000 single-char hits, cap is 1000
		const res = await run(`return(regex.matchAll("a", "${'a'.repeat(2000)}").length())`);
		expect(res).toEqual({ ok: true, value: 1000 });
	});
});
