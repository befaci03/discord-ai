// SMTP addon: registry gate, input validation, recipient allowlist,
// attachment jail, and one real end-to-end send against a mock SMTP server
// (proves nodemailer runs under Bun without touching the network).

import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadConfig, resetConfigCache, AppConfig } from '../../src/utils/config.js';
import { AddonRegistry } from '../../src/modules/addons.js';
import { SMTP } from '../../modules/addons/smtp.js';

/** example-config fixture with an [addons.smtp] section of our choosing */
function makeConfig(smtp: Record<string, unknown>): AppConfig {
	const base = loadConfig('example.config.toml');
	return { ...base, addons: { enabled: ['smtp'], github: {}, tunnel: {}, smtp } } as AppConfig;
}

async function initAndFn(smtp: Record<string, unknown>): Promise<(args: Record<string, unknown>) => Promise<unknown>> {
	const ok = await SMTP.init!(makeConfig(smtp)); // init exists on our addon literal
	if (!ok) throw new Error('smtp addon refused to init (missing host/from in fixture?)');
	const send = SMTP.functions.find((f) => f.name === 'smtp_send_email');
	if (!send) throw new Error('smtp_send_email not registered');
	return send.execute;
}

/** minimal SMTP peer: enough for nodemailer's EHLO/MAIL/RCPT/DATA/QUIT */
interface MockSmtp {
	port: number;
	mails: string[];
	close: () => Promise<void>;
}

function startMockSmtp(): Promise<MockSmtp> {
	const mails: string[] = [];
	const sockets = new Set<import('node:net').Socket>();
	const server: Server = createServer((sock) => {
		sockets.add(sock);
		let buffer = '';
		let inData = false;
		let data = '';
		sock.write('220 mock.local ESMTP ready\r\n');
		sock.on('data', (chunk) => {
			buffer += chunk.toString('utf8');
			for (;;) {
				if (inData) {
					const end = buffer.indexOf('\r\n.\r\n');
					if (end === -1) return;
					data += buffer.slice(0, end);
					mails.push(data);
					buffer = buffer.slice(end + 5);
					inData = false;
					data = '';
					sock.write('250 2.0.0 Ok: queued as MOCK1\r\n');
					continue;
				}
				const nl = buffer.indexOf('\r\n');
				if (nl === -1) return;
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 2);
				const cmd = line.toUpperCase();
				if (cmd.startsWith('EHLO')) sock.write('250-mock.local\r\n250 SIZE 10485760\r\n');
				else if (cmd.startsWith('HELO')) sock.write('250 mock.local\r\n');
				else if (cmd.startsWith('MAIL FROM') || cmd.startsWith('RCPT TO') || cmd.startsWith('RSET') || cmd.startsWith('NOOP')) sock.write('250 2.1.0 Ok\r\n');
				else if (cmd.startsWith('DATA')) {
					sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
					inData = true;
				} else if (cmd.startsWith('QUIT')) {
					sock.write('221 2.0.0 Bye\r\n');
					sock.end();
				} else sock.write('500 Error: command not recognized\r\n');
			}
		});
		sock.on('close', () => sockets.delete(sock));
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as { port: number }).port;
			resolve({
				port,
				mails,
				close: () =>
					new Promise<void>((done) => {
						for (const s of sockets) s.destroy();
						server.close(() => done());
					})
			});
		});
	});
}

describe('smtp addon gate', () => {
	beforeEach(() => resetConfigCache());

	test('enabled without host/from stays unconfigured', async () => {
		const addons = new AddonRegistry(makeConfig({}));
		const stats = await addons.loadAll();
		expect(stats.loaded).toEqual([]);
		expect(stats.ignored).toEqual(['github', 'tunnel']);
		expect(addons.status()[0].error).toBe('not configured (missing keys/env)');
		expect(addons.agentFunctions()).toEqual([]);
	});

	test('not listed in addons.enabled = nothing loads even with settings', async () => {
		const base = loadConfig('example.config.toml');
		const cfg = { ...base, addons: { enabled: [], github: {}, tunnel: {}, smtp: { host: 'smtp.example.com', from: 'a@b.co' } } } as AppConfig;
		const addons = new AddonRegistry(cfg);
		const stats = await addons.loadAll();
		expect(stats.loaded).toEqual([]);
		expect(stats.ignored).toContain('smtp');
		// init never ran, nothing is exposed (registry-level, order-independent)
		expect(addons.agentFunctions()).toEqual([]);
		expect(addons.count()).toBe(0);
	});
});

describe('smtp input validation (all pre-network)', () => {
	beforeEach(() => resetConfigCache());

	test('rejects recipients that are not a single plain address', async () => {
		const send = await initAndFn({ host: 'smtp.example.com', from: 'bot@example.com' });
		await expect(send({ to: 'a@x.co, b@x.co', subject: 'hi', body: 'x' })).rejects.toThrow('single plain email address');
		await expect(send({ to: 'victim@x.co\r\nBcc: spam@x.co', subject: 'hi', body: 'x' })).rejects.toThrow('single plain email address');
		await expect(send({ to: '', subject: 'hi', body: 'x' })).rejects.toThrow("'to' must be");
	});

	test('rejects control characters in the subject (header injection)', async () => {
		const send = await initAndFn({ host: 'smtp.example.com', from: 'bot@example.com' });
		await expect(send({ to: 'a@x.co', subject: 'hi\r\nBcc: victim@x.co', body: 'x' })).rejects.toThrow('control characters');
		await expect(send({ to: 'a@x.co', subject: '', body: 'x' })).rejects.toThrow('subject must be');
	});

	test('allowlist denies anything not listed (checked before any network use)', async () => {
		const send = await initAndFn({ host: 'smtp.example.com', from: 'bot@example.com', allowed_recipients: ['admin@corp.example', '@allowed.example'] });
		await expect(send({ to: 'stranger@elsewhere.net', subject: 'hi', body: 'x' })).rejects.toThrow('not in addons.smtp.allowed_recipients');
		await expect(send({ to: 'admin2@corp.example', subject: 'hi', body: 'x' })).rejects.toThrow('not in addons.smtp.allowed_recipients');
	});
});

describe('smtp config strictness (fail loud, never silent fallbacks)', () => {
	beforeEach(() => resetConfigCache());

	test('wrong TOML types throw instead of loosening policy', () => {
		// the bare-string form used to silently become [] = allow every recipient
		expect(() => SMTP.init!(makeConfig({ host: 'smtp.example.com', from: 'a@b.co', allowed_recipients: 'me@example.com' }))).toThrow('must be an array');
		expect(() => SMTP.init!(makeConfig({ host: 'smtp.example.com', from: 'a@b.co', allowed_recipients: ['example.com'] }))).toThrow('must be an email address or');
		expect(() => SMTP.init!(makeConfig({ host: 'smtp.example.com', from: 'a@b.co', allowed_recipients: ['a@b.co', ''] }))).toThrow('must be an email address or');
		expect(() => SMTP.init!(makeConfig({ host: 'smtp.example.com', from: 'a@b.co', port: '587' }))).toThrow('port must be an integer');
		expect(() => SMTP.init!(makeConfig({ host: 'smtp.example.com', from: 'a@b.co', port: 70000 }))).toThrow('out of range');
		expect(() => SMTP.init!(makeConfig({ host: 'smtp.example.com', from: 'a@b.co', secure: 'yes' }))).toThrow('secure must be true or false');
		expect(() => SMTP.init!(makeConfig({ host: 'smtp.example.com', from: 'a@b.co', timeout_ms: 'soon' }))).toThrow('timeout_ms must be a number');
	});

	test('verify() surfaces connection errors without leaking the password', async () => {
		const ok = await SMTP.init!(makeConfig({ host: '127.0.0.1', port: 1, from: 'bot@example.com', user: 'u', pass: 'sekrit-pass', timeout_ms: 1000 }));
		expect(ok).toBe(true);
		const verify = SMTP.functions.find((f) => f.name === 'smtp_verify')!;
		let caught: Error | null = null;
		try {
			await verify.execute({});
		} catch (err) {
			caught = err as Error;
		}
		expect(caught).not.toBeNull();
		expect(caught!.message.startsWith('smtp: ')).toBe(true);
		expect(caught!.message).not.toContain('sekrit-pass');
	});
});

describe('smtp attachment jail', () => {
	beforeEach(() => resetConfigCache());

	let dir: string;
	let outside: string;

	function fixture(): Record<string, unknown> {
		dir = mkdtempSync(path.join(tmpdir(), 'smtp-attach-'));
		outside = mkdtempSync(path.join(tmpdir(), 'smtp-outside-'));
		writeFileSync(path.join(dir, 'note.txt'), 'hello attachment');
		writeFileSync(path.join(outside, 'secret.txt'), 'do not exfiltrate');
		symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'evil.txt'));
		return { host: 'smtp.example.com', from: 'bot@example.com', attachment_dir: dir };
	}

	test('escapes, symlinks out, and missing files are refused', async () => {
		const send = await initAndFn(fixture());
		await expect(send({ to: 'a@x.co', subject: 's', body: 'b', attachments: ['../outside/x.txt'] })).rejects.toThrow('escapes the attachment directory');
		await expect(send({ to: 'a@x.co', subject: 's', body: 'b', attachments: [path.join(outside, 'secret.txt')] })).rejects.toThrow('escapes the attachment directory');
		await expect(send({ to: 'a@x.co', subject: 's', body: 'b', attachments: ['evil.txt'] })).rejects.toThrow('symlink pointing outside');
		await expect(send({ to: 'a@x.co', subject: 's', body: 'b', attachments: ['nope.txt'] })).rejects.toThrow('does not exist');
		await expect(send({ to: 'a@x.co', subject: 's', body: 'b', attachments: 'note.txt' })).rejects.toThrow('array of file paths');
		await expect(send({ to: 'a@x.co', subject: 's', body: 'b', attachments: [42] })).rejects.toThrow('non-empty strings');
		rmSync(dir, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	test('attachment_dir must exist or init refuses', () => {
		expect(() => SMTP.init!(makeConfig({ host: 'h', from: 'a@b.co', attachment_dir: path.join(tmpdir(), 'definitely-not-here-' + Date.now()) }))).toThrow('is not a directory');
	});
});

describe('smtp end-to-end against a mock relay', () => {
	beforeEach(() => resetConfigCache());

	test('verify + send with attachment, mail captured with headers intact', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'smtp-e2e-'));
		writeFileSync(path.join(dir, 'note.txt'), 'hello attachment');
		const mock = await startMockSmtp();
		try {
			const send = await initAndFn({
				host: '127.0.0.1',
				port: mock.port,
				secure: false,
				require_tls: false,
				from: 'Bot <bot@example.com>',
				allowed_recipients: ['@EXAMPLE.COM'], // case-insensitive domain match
				attachment_dir: dir,
				timeout_ms: 5000
			});

			const verify = SMTP.functions.find((f) => f.name === 'smtp_verify')!;
			expect(await verify.execute({})).toEqual({ ok: true, relay: `127.0.0.1:${mock.port}` });

			const res = (await send({ to: 'me@example.com', subject: 'hello there', body: 'test body line', attachments: ['note.txt'] })) as Record<string, unknown>;
			expect(res.ok).toBe(true);
			expect(res.to).toBe('me@example.com');

			expect(mock.mails).toHaveLength(1);
			const mail = mock.mails[0];
			expect(mail).toContain('From: Bot <bot@example.com>');
			expect(mail).toContain('To: me@example.com');
			expect(mail).toContain('Subject: hello there');
			expect(mail).toContain('test body line');
			expect(mail).toContain('note.txt'); // filename made it into the MIME part
		} finally {
			await mock.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15_000);
});
