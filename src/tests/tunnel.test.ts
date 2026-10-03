// Tunnel: what the agent may and may not do to your public routes.
// Services must stay local, hostnames must stay inside allowed_domains, the
// operator's own hostname is always the first ingress rule, and the mutating
// functions do not exist at all until allow_route_creation is on.
// Nothing here spawns cloudflared.

import { describe, test, expect } from 'bun:test';
import { checkService, isLocalService, domainAllowed, checkHostname, checkTunnelId, checkCredentialsPath, TunnelConfig } from '../../modules/addons/tunnel_runtime.js';
import { RouteManager, MAX_ROUTES } from '../../modules/addons/tunnel_routes.js';
import { buildFunctions } from '../../modules/addons/tunnel.js';

function config(over: Partial<TunnelConfig> = {}): TunnelConfig {
	return {
		mode: 'named',
		binary: 'cloudflared',
		service: 'http://127.0.0.1:3000',
		hostname: 'dash.example.com',
		allowed_domains: ['example.com', '*.example.net'],
		allow_route_creation: false,
		tunnel_id: '11111111-2222-3333-4444-555555555555',
		...over
	};
}

function errorOf(call: () => unknown): string {
	try {
		call();
	} catch (err) {
		return (err as Error).message;
	}
	return '';
}

async function failureOf(call: () => Promise<unknown>): Promise<string> {
	try {
		await call();
	} catch (err) {
		return (err as Error).message;
	}
	return '';
}

describe('service targets stay local', () => {
	test('loopback, private and link-local addresses are accepted', () => {
		expect(isLocalService('http://127.0.0.1:8080')).toBe(true);
		expect(isLocalService('http://localhost:3000')).toBe(true);
		expect(isLocalService('http://192.168.1.10/app')).toBe(true);
		expect(isLocalService('http://10.0.0.5')).toBe(true);
		expect(isLocalService('http://172.16.0.1:8443')).toBe(true);
		expect(isLocalService('http://[::1]:8080')).toBe(true);
		expect(isLocalService('http://[fd00::1]:8080')).toBe(true);
	});

	test('public hosts are refused: a tunnel must not become an open proxy', () => {
		expect(isLocalService('http://8.8.8.8')).toBe(false);
		expect(isLocalService('http://evil.example.com')).toBe(false);
		expect(isLocalService('http://1.2.3.4:80/x')).toBe(false);
		expect(errorOf(() => checkService('http://evil.example.com'))).toContain('not a local address');
		expect(errorOf(() => checkService('javascript:alert(1)'))).toContain('must look like');
		expect(errorOf(() => checkService(''))).toContain('must look like');
	});
});

describe('allowed_domains', () => {
	test('exact entries match only themselves, wildcards cover subdomains', () => {
		expect(domainAllowed('example.com', ['example.com'])).toBe(true);
		expect(domainAllowed('app.example.com', ['example.com'])).toBe(false);
		expect(domainAllowed('app.example.com', ['*.example.com'])).toBe(true);
		expect(domainAllowed('example.com', ['*.example.com'])).toBe(false);
		expect(domainAllowed('app.example.com', [])).toBe(false);
	});

	test('an empty allowlist refuses every hostname, with the config key in the message', () => {
		expect(errorOf(() => checkHostname('app.example.com', []))).toContain('allowed_domains');
	});

	test('a hostname outside the list is refused and names the list', () => {
		const err = errorOf(() => checkHostname('other.org', ['example.com']));
		expect(err).toContain('other.org');
		expect(err).toContain('allowed_domains');
	});

	test('hostnames are normalized and shape-checked', () => {
		expect(checkHostname('Example.COM', ['example.com'])).toBe('example.com');
		expect(checkHostname('APP.Example.NET', ['*.example.net'])).toBe('app.example.net');
		expect(errorOf(() => checkHostname('not a host!', ['example.com']))).toContain('plain hostname');
		expect(errorOf(() => checkHostname('-bad.example.com', ['example.com']))).toContain('plain hostname');
	});
});

describe('tunnel id / credentials path', () => {
	test('only yaml-safe values are accepted', () => {
		expect(checkTunnelId('6ff42ae2-765d-4adf-8112-31c55c1551ef')).toBe('6ff42ae2-765d-4adf-8112-31c55c155555'.slice(0, 0) + '6ff42ae2-765d-4adf-8112-31c55c1551ef');
		expect(errorOf(() => checkTunnelId('evil\ningress: []'))).toContain('tunnel_id');
		expect(errorOf(() => checkCredentialsPath('/path/with spaces/creds.json'))).toContain('credentials_file');
		expect(errorOf(() => checkCredentialsPath('/path/"quoted"'))).toContain('credentials_file');
	});
});

describe('the route functions respect allow_route_creation', () => {
	function functions(over: Partial<TunnelConfig> = {}) {
		const cfg = config(over);
		return buildFunctions(cfg, () => null, new RouteManager(cfg));
	}

	test('read-only when the flag is off', () => {
		expect(functions().map((f) => f.name)).toEqual(['tunnel_status', 'tunnel_list_routes']);
	});

	test('create/edit/remove appear when the flag is on, all flagged as mutating', () => {
		const fns = functions({ allow_route_creation: true });
		expect(fns.map((f) => f.name)).toEqual(['tunnel_status', 'tunnel_list_routes', 'tunnel_create_route', 'tunnel_edit_route', 'tunnel_remove_route']);
		for (const name of ['tunnel_create_route', 'tunnel_edit_route', 'tunnel_remove_route']) {
			expect(fns.find((f) => f.name === name)?.dangerous).toBe(true);
		}
		expect(fns.find((f) => f.name === 'tunnel_status')?.dangerous).toBe(false);
	});

	test('tunnel_status reports the protected hostname even while down', async () => {
		const cfg = config();
		const [statusFn] = buildFunctions(cfg, () => null, new RouteManager(cfg));
		const s = (await statusFn.execute({})) as { hostname: string; running: boolean; error?: string };
		expect(s.hostname).toBe('dash.example.com');
		expect(s.running).toBe(false);
		expect(s.error).toBe('tunnel not running');
	});

	test('creating a route refuses a public service target', async () => {
		const cfg = config({ allow_route_creation: true });
		const routes = new RouteManager(cfg);
		const create = buildFunctions(cfg, () => null, routes).find((f) => f.name === 'tunnel_create_route')!;
		expect(await failureOf(() => create.execute({ service: 'http://evil.example.com' }))).toContain('not a local address');
		expect(routes.list()).toEqual([]);
	});

	test('hostname routes are refused outside allowed_domains', async () => {
		const cfg = config({ allow_route_creation: true });
		const routes = new RouteManager(cfg);
		const create = buildFunctions(cfg, () => null, routes).find((f) => f.name === 'tunnel_create_route')!;
		expect(await failureOf(() => create.execute({ service: 'http://127.0.0.1:8080', hostname: 'nope.org' }))).toContain('allowed_domains');
		expect(routes.list()).toEqual([]);
	});
});

describe('route table', () => {
	test('hostname routes go through allowed_domains and the protected base rule wins the config', async () => {
		const cfg = config({ allow_route_creation: true });
		const routes = new RouteManager(cfg);
		routes.onChanged = async () => undefined; // no cloudflared in tests

		const created = (await routes.create('http://127.0.0.1:8080', 'App.Example.net')) as { id: string; kind: string; url: string };
		expect(created.kind).toBe('hostname');
		expect(created.url).toBe('https://app.example.net');
		expect(created.id).toMatch(/^r[0-9a-f]{8}$/);
		expect(routes.list()).toHaveLength(1);

		const yaml = routes.buildConfig({ hostname: 'dash.example.com', service: 'http://127.0.0.1:3000' });
		expect(yaml).toContain('tunnel: 11111111-2222-3333-4444-555555555555');
		// operator rule first, agent rule after, catch-all closes the file
		expect(yaml.indexOf('- hostname: dash.example.com')).toBeLessThan(yaml.indexOf('- hostname: app.example.net'));
		expect(yaml.trimEnd().endsWith('- service: http_status:404')).toBe(true);

		// edit the service, then remove: both end up back in the config
		const edited = (await routes.edit(created.id, 'http://127.0.0.1:9000')) as { service: string };
		expect(edited.service).toBe('http://127.0.0.1:9000');
		expect(routes.buildConfig({ service: 'http://127.0.0.1:3000' })).toContain('http://127.0.0.1:9000');

		await routes.remove(created.id);
		expect(routes.list()).toEqual([]);
		expect(routes.buildConfig({ service: 'http://127.0.0.1:3000' })).not.toContain('app.example.net');
	});

	test('without a hostname in config the catch-all still serves the base service', () => {
		const routes = new RouteManager(config({ hostname: undefined }));
		const yaml = routes.buildConfig({ service: 'http://127.0.0.1:3000' });
		expect(yaml).toContain('- service: http://127.0.0.1:3000');
		expect(yaml).not.toContain('http_status:404');
	});

	test('hostname routes need a locally managed tunnel in named mode', async () => {
		const noTunnelId = new RouteManager(config({ allow_route_creation: true, tunnel_id: undefined }));
		expect(await failureOf(() => noTunnelId.create('http://127.0.0.1:8080', 'app.example.net'))).toContain('tunnel_id');

		const quick = new RouteManager(config({ allow_route_creation: true, mode: 'quick' }));
		expect(await failureOf(() => quick.create('http://127.0.0.1:8080', 'app.example.net'))).toContain('named');
	});

	test('unknown route ids are refused with a pointer to tunnel_list_routes', async () => {
		const cfg = config({ allow_route_creation: true });
		const routes = new RouteManager(cfg);
		routes.onChanged = async () => undefined;
		expect(await failureOf(() => routes.edit('r00000000', 'http://127.0.0.1:1'))).toContain('unknown route');
		expect(await failureOf(() => routes.remove('r00000000'))).toContain('tunnel_list_routes');
	});

	test('a failed reload rolls the route back AND rewrites the config from that state', async () => {
		const cfg = config({ allow_route_creation: true });
		const routes = new RouteManager(cfg);
		let calls = 0;
		routes.onChanged = async () => {
			calls++;
			if (calls === 1) throw new Error('restart exploded'); // the write succeeded, the restart did not
		};
		expect(await failureOf(() => routes.create('http://127.0.0.1:8080', 'app.example.net'))).toContain('restart exploded');
		expect(routes.list()).toEqual([]);
		// second call = the rollback pass: without it the on-disk ingress file
		// would keep publishing a route memory no longer knows about
		expect(calls).toBe(2);
		expect(routes.buildConfig({ service: 'http://127.0.0.1:3000' })).not.toContain('app.example.net');
	});
});
