// Docker builtin: the enabled gate must hold for every op, paths must never
// reach a shell string unchecked, and image/port policy runs before any CLI.
// Agent volumes live in <volumeRoot>/<volume_id> (sandbox/.docker-vols).

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Docker, DockerPolicy, splitArgv } from '../utils/toolang/builtins/docker.js';

function policy(over: Partial<DockerPolicy> = {}): DockerPolicy {
	return {
		enabled: false,
		defaultImage: 'debian:bookworm',
		allowedPorts: ['3456-35665'],
		disallowedImages: ['ftp', 'ssh', 'windows'],
		maxContainers: 100,
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

describe('docker enabled gate', () => {
	test('every op refuses while [docker].enabled is false, naming the op', () => {
		const d = Docker(() => policy());
		const ops: [string, () => unknown][] = [
			['list', () => d.list()],
			['run', () => d.run('web', 'ls -la')],
			['create', () => d.create('web', { image: 'nginx:alpine' })],
			['remove', () => d.remove('web')],
			['start', () => d.start('web')],
			['stop', () => d.stop('web')],
			['restart', () => d.restart('web')],
			['get_info', () => d.get_info('web')],
			['get_state', () => d.get_state('web')],
			['get_console_logs', () => d.get_console_logs('web')],
			['get_file_content', () => d.get_file_content('web', '/etc/hosts')],
			['rmfile', () => d.rmfile('web', '/tmp/a')],
			['mvfile', () => d.mvfile('web', '/tmp/a', '/tmp/b')],
			['edit_file', () => d.edit_file('web', '/tmp/a', 'hi')],
			['mkdir', () => d.mkdir('web', '/tmp/x')],
			['rmdir', () => d.rmdir('web', '/tmp/x')],
			['lsdir', () => d.lsdir('web', '/tmp')],
			['mvdir', () => d.mvdir('web', '/tmp/a', '/tmp/b')],
			['recreate', () => d.recreate('web')],
			['edit', () => d.edit('web', { image: 'nginx:alpine' })],
			['attach', () => d.attach('web', 'data', '/data')],
			['detach', () => d.detach('web', 'data')],
			['cp', () => d.cp('web', 'a.txt', '/usr/share/a.txt')]
		];
		for (const [op, call] of ops) {
			const err = errorOf(call);
			expect(err, `docker.${op} must be gated`).toContain('docker is disabled');
			expect(err, `docker.${op} must name itself in the error`).toContain(`docker.${op}:`);
		}
	});
});

describe('edit_file', () => {
	test('refuses paths that would reach the shell unchecked', () => {
		const d = Docker(() => policy({ enabled: true }));
		expect(errorOf(() => d.edit_file('web', '/app/a; rm -rf /', 'x'))).toContain('invalid path');
		expect(errorOf(() => d.edit_file('web', '/app/$(whoami)', 'x'))).toContain('invalid path');
		expect(errorOf(() => d.edit_file('web', '/app/`id`', 'x'))).toContain('invalid path');
		expect(errorOf(() => d.edit_file('web', '/app/../../etc/passwd', 'x'))).toContain('invalid path');
		expect(errorOf(() => d.edit_file('web', '/app/with space.txt', 'x'))).toContain('invalid path');
		expect(errorOf(() => d.edit_file('web', '', 'x'))).toContain('invalid path');
	});

	test('caps the content size', () => {
		const d = Docker(() => policy({ enabled: true }));
		expect(errorOf(() => d.edit_file('web', '/app/ok.txt', 'x'.repeat(1_000_001)))).toContain('exceeds');
	});

	test('still gates before touching the CLI', () => {
		const d = Docker(() => policy({ enabled: false }));
		expect(errorOf(() => d.edit_file('web', '/app/ok.txt', 'content'))).toContain('docker is disabled');
	});
});

describe('host mounts and publish policy', () => {
	test('host mounts are refused unless [docker].allowed_volume_paths says so', () => {
		const d = Docker(() => policy({ enabled: true }));
		const err = errorOf(() => d.create('web', { image: 'nginx:alpine', volumes: [{ host: '/etc', container: '/host' }] }));
		expect(err).toContain('allowed_volume_paths');
	});

	test('mounts only work inside the allowlist, and path tricks do not widen it', () => {
		const d = Docker(() => policy({ enabled: true, allowedVolumePaths: ['/srv/work'] }));
		// outside the root
		expect(errorOf(() => d.create('web', { image: 'nginx:alpine', volumes: [{ host: '/srv/other', container: '/data' }] }))).toContain('outside');
		// /srv/work/../other resolves to /srv/other: must not pass by prefix
		expect(errorOf(() => d.create('web', { image: 'nginx:alpine', volumes: [{ host: '/srv/work/../other', container: '/data' }] }))).toContain('outside');
		// the container side must be absolute and stay inside the container
		expect(errorOf(() => d.create('web', { image: 'nginx:alpine', volumes: [{ host: '/srv/work', container: 'relative/dir' }] }))).toContain('absolute');
		expect(errorOf(() => d.create('web', { image: 'nginx:alpine', volumes: [{ host: '/srv/work', container: '/data/../etc' }] }))).toContain('absolute');
		// a mount INSIDE the root passes the volume check (and then fails on the
		// image denylist instead, so we know the mount itself was accepted)
		expect(errorOf(() => d.create('web', { image: 'ftp', volumes: [{ host: '/srv/work', container: '/data' }] }))).toContain('disallowed');
	});

	test('env flags cannot pull HOST secrets into the container', () => {
		const d = Docker(() => policy({ enabled: true }));
		// `-e NAME` (no value) makes the docker CLI copy NAME from ITS OWN env
		expect(errorOf(() => d.create('web', { image: 'nginx:alpine', additional_args: ['-e', 'GITHUB_TOKEN'] }))).toContain('HOST environment variable');
		expect(errorOf(() => d.create('web', { image: 'nginx:alpine', additional_args: ['--env=DISCORD_TOKEN'] }))).toContain('HOST environment variable');
		// --env-file reads an arbitrary host file into the container env
		expect(errorOf(() => d.create('web', { image: 'nginx:alpine', additional_args: ['--env-file', '/proc/self/environ'] }))).toContain('refused');
		expect(errorOf(() => d.create('web', { image: 'nginx:alpine', additional_args: ['--volumes-from', 'db'] }))).toContain('refused');
		// explicit KEY=value pairs are fine (this one fails later, on the image)
		expect(errorOf(() => d.create('web', { image: 'ftp', additional_args: ['-e', 'MODE=prod'] }))).toContain('disallowed');
	});

	test('published ports bind to loopback unless bind_address says otherwise', () => {
		// public binds must be asked for explicitly, and even then only loopback/
		// private/0.0.0.0 shapes are accepted
		expect(errorOf(() => Docker(() => policy({ enabled: true, bindAddress: '8.8.8.8' })).create('web', { image: 'nginx:alpine', ports: [3456] }))).toContain('bind_address');
		expect(errorOf(() => Docker(() => policy({ enabled: true, bindAddress: '0.0.0.0' })).create('web', { image: 'ftp', ports: [3456] }))).toContain('disallowed');
		expect(errorOf(() => Docker(() => policy({ enabled: true })).create('web', { image: 'ftp', ports: [3456] }))).toContain('disallowed');
	});
});

describe('agent volumes (.docker-vols)', () => {
	/** a fresh store per test: the repo's sandbox must stay untouched */
	function storeDir(): string {
		return mkdtempSync(path.join(tmpdir(), 'volstore-'));
	}
	const drop = (dir: string) => rmSync(dir, { recursive: true, force: true });

	test('a volume id resolves into the store and needs no allowlist entry', () => {
		const store = storeDir();
		const d = Docker(() => policy({ enabled: true, volumeRoot: store }));
		// the volume check runs before the image check: the denylisted image
		// proves the mount itself was accepted (and no allowed_volume_paths!)
		const err = errorOf(() => d.create('web', { image: 'ftp', volumes: [{ volume: 'data', container: '/var/lib/data' }] }));
		expect(err).toContain('disallowed');
		// the store dir now exists on disk, owned by us, not root-created by docker
		expect(statSync(path.join(store, 'data')).isDirectory()).toBe(true);
		drop(store);
	});

	test('volume ids stay a single path segment', () => {
		const store = storeDir();
		const d = Docker(() => policy({ enabled: true, volumeRoot: store }));
		const bad = ['../etc', 'a/b', '.hidden', '', '..', 'with space', 'x'.repeat(65)];
		for (const id of bad) {
			const err = errorOf(() => d.create('web', { image: 'nginx:alpine', volumes: [{ volume: id, container: '/data' }] }));
			expect(err, `volume id '${id.slice(0, 20)}' must be refused`).toContain('invalid volume id');
		}
		drop(store);
	});

	test('without a store configured, agent volumes are refused', () => {
		const d = Docker(() => policy({ enabled: true }));
		const err = errorOf(() => d.create('web', { image: 'nginx:alpine', volumes: [{ volume: 'data', container: '/data' }] }));
		expect(err).toContain('unavailable');
	});

	test('binds inside the store survive re-validation without an allowlist', () => {
		const store = storeDir();
		const d = Docker(() => policy({ enabled: true, volumeRoot: store, allowedVolumePaths: [] }));
		// this is exactly what recreate/attach feed back from docker inspect:
		// the mount WE created must not need an allowed_volume_paths entry
		expect(errorOf(() => d.create('web', { image: 'ftp', volumes: [{ host: path.join(store, 'data'), container: '/data' }] }))).toContain('disallowed');
		// ...while an arbitrary host path outside the store still dies
		expect(errorOf(() => d.create('web', { image: 'ftp', volumes: [{ host: '/etc', container: '/data' }] }))).toContain('allowed_volume_paths');
		drop(store);
	});

	test('attach validates everything before docker is touched', () => {
		const store = storeDir();
		const d = Docker(() => policy({ enabled: true, volumeRoot: store }));
		expect(errorOf(() => d.attach('web', '../etc', '/data'))).toContain('invalid volume id');
		expect(errorOf(() => d.attach('web', '', '/data'))).toContain('invalid volume id');
		expect(errorOf(() => d.attach('web', 'data', 'relative/path'))).toContain('absolute');
		expect(errorOf(() => d.attach('web', 'data', '/data/../x'))).toContain('absolute');
		// no store at all: refused before any docker call
		expect(errorOf(() => Docker(() => policy({ enabled: true })).attach('web', 'data', '/data'))).toContain('unavailable');
		// good inputs reach `docker inspect`, which fails here (no docker/daemon)
		// with a message that says which container could not be read
		expect(errorOf(() => d.attach('web', 'data', '/data'))).toContain('could not read the image');
		drop(store);
	});

	test('detach identifies the mount by volume id alone, before docker is touched', () => {
		const store = storeDir();
		const d = Docker(() => policy({ enabled: true, volumeRoot: store }));
		expect(errorOf(() => d.detach('web', '../etc'))).toContain('invalid volume id');
		expect(errorOf(() => d.detach('web', ''))).toContain('invalid volume id');
		expect(errorOf(() => d.detach('bad;name', 'data'))).toContain('invalid container name');
		expect(errorOf(() => d.detach('web', 'data', 'not/absolute'))).toContain('absolute');
		// no store: refused before any docker call
		expect(errorOf(() => Docker(() => policy({ enabled: true })).detach('web', 'data'))).toContain('unavailable');
		// good inputs reach `docker inspect`, which fails here (no docker/daemon)
		expect(errorOf(() => d.detach('web', 'data'))).toContain('could not read the image');
		drop(store);
	});
});

describe('docker.run argv splitting', () => {
	test('quotes group words, no shell is involved', () => {
		expect(splitArgv("sh -c 'echo a b'")).toEqual(['sh', '-c', 'echo a b']);
		expect(splitArgv('grep -e "foo bar" /tmp/x')).toEqual(['grep', '-e', 'foo bar', '/tmp/x']);
		expect(splitArgv('  ls   -la  ')).toEqual(['ls', '-la']);
		// backslash escapes the next char outside quotes
		expect(splitArgv('echo a\\ b')).toEqual(['echo', 'a b']);
		expect(splitArgv('')).toEqual([]);
	});

	test('unbalanced quotes fail with a clear error instead of a container shell error', () => {
		expect(errorOf(() => splitArgv("sh -c 'echo hi"))).toContain('unbalanced');
		expect(errorOf(() => splitArgv('echo "a b'))).toContain('unbalanced');
	});

	test('docker.run refuses an empty command before exec', () => {
		const d = Docker(() => policy({ enabled: true }));
		expect(errorOf(() => d.run('web', '   '))).toContain('must contain a command');
		expect(errorOf(() => d.run('web', ''))).toContain('non-empty');
	});
});

describe('docker.cp', () => {
	/** a fresh sandbox root per test: the repo's sandbox must stay untouched */
	function sandboxDir(): string {
		return mkdtempSync(path.join(tmpdir(), 'cpsandbox-'));
	}

	test('the direction comes from which side is absolute', () => {
		const root = sandboxDir();
		const d = Docker(() => policy({ enabled: true, fsRoot: root }));
		// both absolute / both relative: ambiguous, refused before docker runs
		expect(errorOf(() => d.cp('web', '/a/b.txt', '/c/d.txt'))).toContain('both sides are absolute');
		expect(errorOf(() => d.cp('web', 'a.txt', 'b.txt'))).toContain('no container path');
		// container side: absolute, no '..', same charset as every container path
		expect(errorOf(() => d.cp('web', 'a.txt', '/x/../etc'))).toContain('absolute');
		expect(errorOf(() => d.cp('web', 'a.txt', 'relative/path'))).toContain('no container path');
		// container name goes through the same NAME_RE as every other op
		expect(errorOf(() => d.cp('bad;name', 'a.txt', '/out.txt'))).toContain('invalid container name');
		rmSync(root, { recursive: true, force: true });
	});

	test('the sandbox side stays jailed in fs root', () => {
		const root = sandboxDir();
		const d = Docker(() => policy({ enabled: true, fsRoot: root }));
		expect(errorOf(() => d.cp('web', '../../etc/passwd', '/out.txt'))).toContain('must stay inside');
		expect(errorOf(() => d.cp('web', 'a/../../etc/passwd', '/out.txt'))).toContain('must stay inside');
		// no fs root configured: refused before any docker call
		expect(errorOf(() => Docker(() => policy({ enabled: true })).cp('web', 'a.txt', '/out.txt'))).toContain('unavailable');
		rmSync(root, { recursive: true, force: true });
	});

	test('files above the size cap never cross the boundary', () => {
		const root = sandboxDir();
		writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(64));
		const d = Docker(() => policy({ enabled: true, fsRoot: root, fsMaxFileSize: 32 }));
		expect(errorOf(() => d.cp('web', 'big.txt', '/in.txt'))).toContain('too large');
		rmSync(root, { recursive: true, force: true });
	});
});

describe('image and name policy', () => {
	test('disallowed images are refused before any docker command runs', () => {
		const d = Docker(() => policy({ enabled: true }));
		expect(errorOf(() => d.create('web', { image: 'ftp:latest' }))).toContain('disallowed');
		expect(errorOf(() => d.create('web', { image: 'ssh' }))).toContain('disallowed');
		expect(errorOf(() => d.create('web', { image: 'windows/servercore' }))).toContain('disallowed');
		// the documented (name, image, config) shorthand is validated the same way
		expect(errorOf(() => d.create('web', 'ftp', { ports: [] }))).toContain('disallowed');
	});

	test('an allowlist, when set, beats everything else', () => {
		const d = Docker(() => policy({ enabled: true, allowedImages: ['nginx:alpine'] }));
		expect(errorOf(() => d.create('web', { image: 'redis:7' }))).not.toBe('');
		expect(errorOf(() => d.create('web', { image: 'nginx:alpine', ports: [99_999] }))).toContain('invalid port');
	});

	test('container names and ports are validated', () => {
		const d = Docker(() => policy({ enabled: true }));
		expect(errorOf(() => d.create('bad name!', { image: 'nginx:alpine' }))).toContain('invalid container name');
		expect(errorOf(() => d.create('ok_name', { image: 'nginx:alpine', ports: [80] }))).toContain('outside the allowed ranges');
		expect(errorOf(() => d.run('bad;name', 'ls'))).toContain('invalid container name');
	});
});
