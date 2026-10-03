// The "### Your environment" block: config facts the model used to guess
// (docker port ranges, which creation switches are on, what the tunnel
// publishes) plus the promise that no secret ever rides along.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { loadConfig, resetConfigCache, AppConfig } from '../utils/config.js';
import { environmentBlock } from '../agent/envinfo.js';

function cfg(mutate?: (c: AppConfig) => void): AppConfig {
	const c = loadConfig('example.config.toml');
	mutate?.(c);
	return c;
}

describe('environment block', () => {
	beforeEach(() => resetConfigCache());
	afterEach(() => resetConfigCache());

	test('the docker port range is spelled out when docker is on', () => {
		const block = environmentBlock(
			cfg((c) => {
				c.docker.enabled = true;
			}),
			{ activeAddons: [] }
		);
		expect(block).toContain('### Your environment');
		expect(block).toContain('Host ports you may publish: 3456-35665');
		expect(block).toContain('Max containers: 100');
		expect(block).toContain('Blocked image prefixes: ftp, ssh, windows');
	});

	test('docker off says so instead of letting the model try', () => {
		expect(environmentBlock(cfg(), { activeAddons: [] })).toContain('docker: OFF');
	});

	test('docker on spells out the bind address and the mount policy', () => {
		const block = environmentBlock(
			cfg((c) => {
				c.docker.enabled = true;
			}),
			{ activeAddons: [] }
		);
		expect(block).toContain('bound to 127.0.0.1');
		expect(block).toContain('Host paths you may mount into containers: none');
	});

	test('the github line reports token presence, never a value (not even an unexpanded ${VAR})', () => {
		delete process.env.GITHUB_TOKEN;
		const withRef = environmentBlock(
			cfg((c) => {
				c.addons = { ...c.addons, enabled: ['github'], github: { token: '${GITHUB_TOKEN}' } };
			}),
			{ activeAddons: ['github'] }
		);
		expect(withRef).toContain('token MISSING');
		expect(withRef).not.toContain('${GITHUB_TOKEN}');

		const withToken = environmentBlock(
			cfg((c) => {
				c.addons = { ...c.addons, enabled: ['github'], github: { token: 'ghp_not_a_real_token' } };
			}),
			{ activeAddons: ['github'] }
		);
		expect(withToken).toContain('token configured');
		expect(withToken).not.toContain('ghp_not_a_real_token');
	});

	test('sandbox policy is stated (fs root, shell, http guard)', () => {
		const block = environmentBlock(cfg(), { activeAddons: [] });
		expect(block).toContain('filesystem sandbox: root');
		expect(block).toContain('shell on the host (node.child_proc.run): disabled');
		expect(block).toContain('SSRF guard');
	});

	test('the creation switches say whether manage_tool/manage_skill exist', () => {
		const off = environmentBlock(
			cfg((c) => {
				c.agent.toolang.allowToolCreation = false;
				c.agent.toolang.allowSkillCreation = false;
			}),
			{ activeAddons: [] }
		);
		expect(off).toContain('manage_tool not available');
		expect(off).toContain('manage_skill not available');

		const on = environmentBlock(
			cfg((c) => {
				c.agent.toolang.allowToolCreation = true;
				c.agent.toolang.allowSkillCreation = true;
			}),
			{ activeAddons: [] }
		);
		expect(on).toContain('manage_tool AVAILABLE');
		expect(on).toContain('manage_skill AVAILABLE');
	});

	test('the tunnel line announces the operator hostname as protected', () => {
		const c = cfg();
		c.addons = {
			...c.addons,
			enabled: ['tunnel'],
			tunnel: {
				mode: 'named',
				hostname: 'dash.example.com',
				service: 'http://127.0.0.1:3000',
				allowed_domains: ['example.com', '*.example.net'],
				allow_route_creation: true
			}
		};
		const block = environmentBlock(c, { activeAddons: ['tunnel'] });
		expect(block).toContain('https://dash.example.com');
		expect(block).toContain('never change or remove it');
		expect(block).toContain('Route management: you may create/edit/remove routes');
		expect(block).toContain('Hostnames you may publish: example.com, *.example.net');
	});

	test('github flags and token presence are reported, never the token', () => {
		const c = cfg();
		c.addons = {
			...c.addons,
			enabled: ['github'],
			github: { token: 'ghp_definitely_a_secret', default_owner: 'beci', allowed_repos: ['beci/tool'] }
		};
		const block = environmentBlock(c, { activeAddons: ['github'] });
		expect(block).toContain('default owner beci');
		expect(block).toContain('repo allowlist: beci/tool');
		expect(block).toContain('create/fork/edit repo + create branch: refused');
		expect(block).toContain('delete repo/branch: refused');
		expect(block).not.toContain('ghp_definitely_a_secret');
	});

	test('no provider key ever leaks into the prompt', () => {
		const c = cfg((base) => {
			base.agent.providers = {
				openai: { api_type: 1, base_url: 'https://api.openai.com/v1', api_key: 'sk-ultra_secret_key' }
			};
		});
		const block = environmentBlock(c, { activeAddons: [] });
		expect(block).not.toContain('sk-ultra_secret_key');
		expect(block).not.toContain('ultra_secret');
	});

	test('the block stays bounded no matter what is configured', () => {
		const c = cfg((base) => {
			base.docker.allowedPorts = Array.from({ length: 50 }, (_, i) => `${i}-${i + 1}`);
			base.addons = { ...base.addons, enabled: ['github', 'tunnel', 'smtp'] };
		});
		const block = environmentBlock(c, { activeAddons: ['github', 'tunnel', 'smtp'] });
		expect(block.length).toBeLessThanOrEqual(4_001);
	});
});
