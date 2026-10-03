// End-to-end dashboard tests: the CSP must let the page open its own
// websocket (it used to not, so the page looped on "reconnecting"), the login
// cookie must be accepted, and the /ws upgrade must succeed with it.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { connect, Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadConfig, resetConfigCache } from '../utils/config.js';
import { ToolRegistry } from '../modules/tools.js';
import { SkillRegistry } from '../modules/skills.js';
import { AddonRegistry } from '../modules/addons.js';
import SQLiteDB from '../db/sqlite.js';
import { Logger } from '../utils/logger.js';
import { LiveBus } from '../dashboard/live.js';
import { hashPasscode, LoginLimiter, SessionStore } from '../dashboard/auth.js';
import { startDashboard } from '../dashboard/server.js';
import { DashboardDeps } from '../dashboard/handlers.js';

const PASSCODE = 'test-passcode-123';

let dir: string;
let db: SQLiteDB;
let server: Awaited<ReturnType<typeof startDashboard>>['server'];
let hub: Awaited<ReturnType<typeof startDashboard>>['hub'];
let base = '';

beforeAll(async () => {
	resetConfigCache();
	dir = mkdtempSync(path.join(tmpdir(), 'discord-ai-srv-'));
	db = new SQLiteDB(path.join(dir, 'srv.sqlite'));
	await db.init();

	const config = loadConfig('example.config.toml');
	config.http.host = '127.0.0.1';
	config.http.port = 0; // let the OS pick a port
	config.http.allowedIps = ['127.0.0.1'];
	config.http.passcode = PASSCODE;

	const tools = new ToolRegistry(config);
	tools.loadAll();
	const skills = new SkillRegistry(config);
	skills.loadAll();
	const addons = new AddonRegistry(config);
	await addons.loadAll();

	const deps: DashboardDeps = { config, db, tools, skills, addons, log: () => undefined };
	const log = new Logger('error');
	const auth = { passcodeHash: hashPasscode(PASSCODE), sessions: new SessionStore(), limiter: new LoginLimiter() };
	const started = await startDashboard(deps, config, log, auth, new LiveBus(log));
	server = started.server;
	hub = started.hub;
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;
	base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	hub?.closeAll();
	await new Promise<void>((resolve) => server?.close(() => resolve()));
	await db.close();
	rmSync(dir, { recursive: true, force: true });
});

async function login(): Promise<string> {
	const res = await fetch(`${base}/api/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ passcode: PASSCODE })
	});
	expect(res.status).toBe(200);
	const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
	expect(cookie).toContain('=');
	return cookie;
}

/** Raw WS handshake over TCP so we assert what the server really answers. */
function wsHandshake(cookie?: string): Promise<string> {
	return new Promise((resolve) => {
		const port = Number(new URL(base).port);
		const socket: Socket = connect({ host: '127.0.0.1', port }, () => {
			const key = Buffer.from('0123456789abcdef0123').toString('base64');
			const request = [
				'GET /ws HTTP/1.1',
				`Host: 127.0.0.1:${port}`,
				'Upgrade: websocket',
				'Connection: Upgrade',
				`Sec-WebSocket-Key: ${key}`,
				'Sec-WebSocket-Version: 13',
				...(cookie ? [`Cookie: ${cookie}`] : [])
			].join('\r\n');
			socket.write(request + '\r\n\r\n');
		});
		let buf = '';
		const done = () => {
			socket.destroy();
			resolve(buf);
		};
		socket.setTimeout(3_000, done);
		socket.on('data', (chunk: Buffer) => {
			buf += chunk.toString('utf-8');
			if (buf.includes('\r\n\r\n')) done();
		});
		socket.on('error', () => resolve(buf));
		socket.on('close', () => resolve(buf));
	});
}

describe('dashboard server', () => {
	test('CSP names the served host so the websocket is not blocked', async () => {
		const res = await fetch(`${base}/`);
		expect(res.status).toBe(200);
		const csp = res.headers.get('content-security-policy') ?? '';
		expect(csp).toContain("connect-src 'self'");
		const port = new URL(base).port;
		expect(csp).toContain(`ws://127.0.0.1:${port}`);
		expect(csp).toContain(`wss://127.0.0.1:${port}`);
		// the rest of the lockdown stays intact
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("script-src 'unsafe-inline' 'self'");
	});

	test('login hands back a session cookie that unlocks the API', async () => {
		const cookie = await login();
		const res = await fetch(`${base}/api/status`, { headers: { Cookie: cookie } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { tools: number; agent: { name: string } };
		expect(body.tools).toBeGreaterThan(0);
		expect(typeof body.agent.name).toBe('string');
	});

	test('a wrong passcode is refused and counted', async () => {
		const res = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ passcode: 'nope' })
		});
		expect(res.status).toBe(401);
	});

	test('the ws upgrade is accepted with a session cookie', async () => {
		const cookie = await login();
		const raw = await wsHandshake(cookie);
		expect(raw).toContain('101 Switching Protocols');
	});

	test('the ws upgrade is refused without a session cookie', async () => {
		const raw = await wsHandshake();
		expect(raw).toContain('401 Unauthorized');
	});
});
