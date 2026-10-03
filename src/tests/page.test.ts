// Regression test for the "login() is not defined" bug: the dashboard script
// lives inside a TS template literal, where a stray `\'` cooks down to `'` and
// kills the whole script with one syntax error. Compiling the RENDERED output
// (what the browser actually gets) catches that class of bug.

import { describe, test, expect } from 'bun:test';
import { renderDashboard } from '../dashboard/page.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<void>;

function inlineScript(): string {
	const html = renderDashboard();
	const match = /<script>([\s\S]*?)<\/script>/.exec(html);
	expect(match, 'dashboard must ship one inline <script>').not.toBeNull();
	return match![1];
}

describe('dashboard inline script', () => {
	test('compiles without a syntax error', () => {
		const code = inlineScript();
		expect(code.length).toBeGreaterThan(100);
		expect(() => new AsyncFunction(code)).not.toThrow();
	});

	test('login() is defined and wired to the sign-in form', () => {
		const html = renderDashboard();
		expect(html).toContain('async function login');
		expect(html).toMatch(/onclick="[^"]*login\(/);
	});

	test('the websocket follows the page scheme (wss behind https)', () => {
		const code = inlineScript();
		// hardcoded ws:// dies under a reverse proxy or the cloudflared tunnel:
		// the browser blocks it as mixed content and reconnects forever
		expect(code).toContain('location.protocol === "https:" ? "wss://" : "ws://"');
		expect(code).not.toContain('new WebSocket("ws://" + location.host');
		// an intentional close must not schedule another reconnect loop
		expect(code).toContain('wsWanted');
		expect(code).toContain('function disconnectWs');
	});

	test('toggle buttons keep their quotes escaped', () => {
		const html = renderDashboard();
		// the old bug: `onclick="toggle('tool',...)"` built inside a single-quoted
		// JS string of a TS template literal, where `\'` cooks down to `'`
		expect(html).toContain('toggle(&quot;tool&quot;');
		expect(html).toContain('toggle(&quot;skill&quot;');
		expect(html).toContain('toggle(&quot;addon&quot;');
	});
});
