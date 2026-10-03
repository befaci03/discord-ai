/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// Docker builtin for TooLang.
// Docker itself is the attack surface here: names, images and paths all go
// through validation before touching the CLI. fuck docker but better than hell lmao

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { RuntimeError } from '../evaluator.js';

export interface DockerPolicy {
	enabled: boolean;
	/** docker host, e.g. "unix:///var/run/docker.sock" or "tcp://1.2.3.4:2375" */
	host?: string;
	/** port ranges the llm may publish, e.g. ["3456-35665"] */
	allowedPorts?: string[];
	/** images that are refused (checked as prefix, so "ftp" blocks "ftp:latest" too) */
	disallowedImages?: string[];
	/** image allowlist; empty/undefined = anything not disallowed */
	allowedImages?: string[];
	maxContainers?: number;
	defaultImage: string;
	/** host paths the llm may bind-mount; empty/undefined = no host mounts */
	allowedVolumePaths?: string[];
	/** interface published ports bind to (default 127.0.0.1 = this box only) */
	bindAddress?: string;
}

function drun(cmdArgs: string[], host?: string, input?: string): { stdout: string; stderr: string; exitCode: number } {
	try {
		// host comes from config (docker.host), passed as env like the docker CLI expects
		const envVars: NodeJS.ProcessEnv = host ? { ...process.env, DOCKER_HOST: host } : process.env;
		const stdout = execFileSync('docker', cmdArgs, { encoding: 'utf-8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: envVars, input });
		return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
	} catch (err: unknown) {
		const e = err as { stdout?: string; stderr?: string; status?: number };
		return { stdout: e.stdout?.trim() ?? '', stderr: e.stderr?.trim() ?? '', exitCode: e.status ?? 1 };
	}
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function checkName(name: unknown, op: string): string {
	if (typeof name !== 'string' || !NAME_RE.test(name)) throw new RuntimeError(`docker.${op}: invalid container name '${String(name).slice(0, 40)}'`);
	return name;
}

function checkImage(image: string, policy: DockerPolicy, op: string): string {
	if (typeof image !== 'string' || image.length === 0 || image.length > 255 || !IMAGE_RE.test(image)) {
		throw new RuntimeError(`docker.${op}: invalid image name '${String(image).slice(0, 60)}'`);
	}
	for (const bad of policy.disallowedImages ?? []) {
		if (image === bad || image.startsWith(bad + ':') || image.startsWith(bad + '/')) {
			throw new RuntimeError(`docker.${op}: image '${image}' is disallowed`);
		}
	}
	if (policy.allowedImages && policy.allowedImages.length > 0) {
		const ok = policy.allowedImages.some((good) => image === good || image.startsWith(good + ':') || image.startsWith(good + '/'));
		if (!ok) throw new RuntimeError(`docker.${op}: image '${image}' is not in the allowed list`);
	}
	return image;
}

function checkPort(port: unknown, policy: DockerPolicy, op: string): number {
	const p = Number(port);
	if (!Number.isInteger(p) || p < 1 || p > 65535) throw new RuntimeError(`docker.${op}: invalid port ${String(port)}`);
	const ranges = policy.allowedPorts ?? [];
	for (const range of ranges) {
		const [lo, hi] = range.split('-').map(Number);
		if (p >= (lo ?? 0) && p <= (hi ?? lo ?? 0)) return p;
	}
	// the model has no other way to learn the actual range: name it
	throw new RuntimeError(ranges.length > 0 ? `docker.${op}: port ${p} is outside the allowed ranges (${ranges.join(', ')})` : `docker.${op}: port ${p} refused, [docker].allowed_ports is empty`);
}

const PATH_RE = /^\/?[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/;
/** images allow a registry/path, a tag and a digest: `host/ns/img:tag@sha256:...` */
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9_.\/:@-]{0,254}$/;
const FILE_CONTENT_CAP = 1_000_000; // bytes a tool may write into a container
/** extra docker flags that hand the container the host (refused everywhere) */
const UNSAFE_CREATE_ARGS = [
	'-v',
	'--volume',
	'--mount',
	'--bind',
	'--privileged',
	'--cap-add',
	'--security-opt',
	'--pid',
	'--network',
	'--net',
	'--device',
	'--devices',
	'--userns',
	'--cgroupns',
	'--ipc',
	'--uts',
	'--runtime',
	'--add-host',
	'--volumes-from'
];

/**
 * Container paths: letters, digits, _ . - / only, no `..`. Checked even for
 * the argv-only calls so every file op accepts the same charset, and strictly
 * required wherever the path ends up in a shell string (edit_file).
 */
function checkPath(p: unknown, op: string): string {
	const s = String(p ?? '');
	if (s.length === 0 || s.length > 1000 || !PATH_RE.test(s) || s.includes('..')) {
		throw new RuntimeError(`docker.${op}: invalid path '${s.slice(0, 60)}' (letters, digits, _ . - / only, no '..')`);
	}
	return s;
}

/** Destination inside the container: absolute, same charset as checkPath. */
const CONTAINER_PATH_RE = /^\/[A-Za-z0-9_./-]*$/;
/**
 * Interfaces a published port may bind to. Loopback and private ranges only:
 * 0.0.0.0 has to be asked for explicitly (see [docker].bind_address), because
 * a published port on a public box is instantly reachable from the internet.
 */
const BIND_RE = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|localhost|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

/** Where `-p` binds: fails closed on anything not on the safe list. */
function checkBind(policy: DockerPolicy, op: string): string {
	const bind = typeof policy.bindAddress === 'string' && policy.bindAddress.trim() ? policy.bindAddress.trim() : '127.0.0.1';
	if (!BIND_RE.test(bind)) {
		throw new RuntimeError(`docker.${op}: [docker].bind_address '${bind.slice(0, 40)}' must be 127.0.0.1, localhost, 0.0.0.0 or a private address`);
	}
	return bind;
}

/**
 * One `-v host:container` bind. The host side is the dangerous one: without
 * an allowlist the llm could mount /etc (or the whole disk) into a container
 * and read it back through docker.get_file_content. So: resolve the path, then
 * demand it sits inside [docker].allowed_volume_paths.
 */
function checkVolumeBind(v: { host?: unknown; container?: unknown }, policy: DockerPolicy, op: string): string {
	if (typeof v?.host !== 'string' || typeof v?.container !== 'string') {
		throw new RuntimeError(`docker.${op}: volume entries need host and container paths`);
	}
	const container = v.container;
	if (container.length === 0 || container.length > 1000 || !CONTAINER_PATH_RE.test(container) || container.includes('..')) {
		throw new RuntimeError(`docker.${op}: container path '${container.slice(0, 60)}' must be absolute (letters, digits, _ . - / only, no '..')`);
	}
	// resolve first, so a /data/../etc trick cannot slide past the prefix check
	const host = path.resolve(v.host);
	const roots = (policy.allowedVolumePaths ?? []).map((r) => path.resolve(String(r)));
	const inside = roots.some((root) => host === root || host.startsWith(root + path.sep));
	if (!inside) {
		throw new RuntimeError(
			roots.length > 0
				? `docker.${op}: host path '${host.slice(0, 80)}' is outside [docker].allowed_volume_paths`
				: `docker.${op}: host mounts are refused (set [docker].allowed_volume_paths to the paths the llm may mount, e.g. ["${host.slice(0, 80)}"])`
		);
	}
	return `${host}:${container}`;
}

interface DockerConfig {
	memory?: string;
	cpu?: number;
	ports?: number[];
	volumes?: { host: string; container: string }[];
	additional_args?: string[];
	image?: string;
}

function buildCreateArgs(name: string, config: DockerConfig, policy: DockerPolicy, op = 'create'): string[] {
	const args: string[] = ['create', '--name', name];
	if (config.memory) args.push('--memory', String(config.memory));
	if (config.cpu) args.push('--cpus', String(config.cpu));
	if (config.ports) {
		const bind = checkBind(policy, op);
		for (const p of config.ports) {
			const port = checkPort(p, policy, op);
			args.push('-p', `${bind}:${port}:${port}`);
		}
	}
	if (config.volumes) {
		for (const v of config.volumes) {
			args.push('-v', checkVolumeBind(v, policy, op));
		}
	}
	if (config.additional_args) {
		// these reach the docker CLI verbatim: a flag that mounts the host,
		// escapes the container or copies host env into the container would
		// undo every other check in here
		const list = config.additional_args;
		for (let i = 0; i < list.length; i++) {
			const a = String(list[i]);
			if (UNSAFE_CREATE_ARGS.some((bad) => a === bad || a.startsWith(bad + '='))) {
				throw new RuntimeError(`docker.${op}: additional_args entry '${a.slice(0, 40)}' is refused (host access)`);
			}
			// --env-file reads an arbitrary HOST file into the container env
			if (a === '--env-file' || a.startsWith('--env-file=')) {
				throw new RuntimeError(`docker.${op}: additional_args entry '${a.slice(0, 40)}' is refused (reads a host file)`);
			}
			// `-e NAME` (no =) makes the docker CLI copy NAME from ITS OWN env:
			// a direct line from the host's secrets into the container, where any
			// tool can read them back with printenv
			if (a === '-e' || a === '--env') {
				const next = String(list[i + 1] ?? '');
				if (!next.includes('=')) {
					throw new RuntimeError(`docker.${op}: '${a} ${next.slice(0, 20)}' would copy a HOST environment variable; write '${a} KEY=value' instead`);
				}
				args.push(a, next);
				i++;
				continue;
			}
			// the same rule for the attached forms (-eFOO / --env=FOO)
			const inlineEnv = a.startsWith('--env=') ? a.slice(6) : a.startsWith('-e') && !a.startsWith('--') && a.length > 2 ? a.slice(2) : '';
			if (inlineEnv.length > 0 && !inlineEnv.includes('=')) {
				throw new RuntimeError(`docker.${op}: additional_args entry '${a.slice(0, 40)}' would copy a HOST environment variable; use '${a.slice(0, 2)}KEY=value'`);
			}
			args.push(a);
		}
	}
	// images from the caller always pass the allow/deny lists (defaultImage is
	// the operator's own config, so it is trusted)
	args.push(config.image ? checkImage(config.image, policy, op) : policy.defaultImage);
	return args;
}

export function Docker(getPolicy: () => DockerPolicy): Record<string, Function> {
	// single choke point: every docker op goes through gate(), so the enabled
	// flag can never be bypassed (it used to be read but never enforced)
	const gate = (op: string): DockerPolicy => {
		const policy = getPolicy();
		if (policy.enabled !== true) {
			throw new RuntimeError(`docker.${op}: docker is disabled (set [docker].enabled = true in config.toml)`);
		}
		return policy;
	};
	const d = (args: string[], op?: string) => {
		// `op` is the TooLang-level name shown to the model; it defaults to the
		// raw docker subcommand when the two are the same
		const policy = gate(op ?? String(args[0] ?? 'run'));
		return drun(args, policy.host);
	};
	return {
		// read-only overview: name, image and status of every container
		list: () => d(['ps', '-a', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}'], 'list'),
		run: (container: string, cmd: string) => {
			gate('run'); // fail fast, before checkName/argv work
			const name = checkName(container, 'run');
			if (typeof cmd !== 'string' || cmd.length === 0) throw new RuntimeError('docker.run: cmd must be a non-empty string');
			// exec via argv array: ["exec", name, "sh", "-c", cmd] would allow shells,
			// so we run the command directly without a shell
			return d(['exec', name, ...cmd.trim().split(/\s+/)], 'run');
		},
		create: (name: string, imageOrConfig?: string | DockerConfig, maybeConfig?: DockerConfig) => {
			const policy = gate('create');
			const cname = checkName(name, 'create');
			// accepts docker.create(name, { image, ... }) and the documented
			// docker.create(name, image, { ... }) shorthand
			let config: DockerConfig;
			if (imageOrConfig === undefined || imageOrConfig === null) config = {};
			else if (typeof imageOrConfig === 'string') config = { ...(maybeConfig ?? {}), image: imageOrConfig };
			else if (typeof imageOrConfig === 'object' && !Array.isArray(imageOrConfig)) config = imageOrConfig;
			else throw new RuntimeError('docker.create: expected (name, image, config?) or (name, config)');
			// validate inputs first (image allow/deny, ports), then check the cap
			const args = buildCreateArgs(cname, config, policy);
			const cap = policy.maxContainers ?? 100;
			const existing = d(['ps', '-a', '-q'], 'create')
				.stdout.split('\n')
				.filter((s) => s.length > 0).length;
			if (existing >= cap) throw new RuntimeError(`docker.create: container limit reached (${cap}), remove one first`);
			return d(args, 'create');
		},

		remove: (container: string) => d(['rm', '-f', checkName(container, 'remove')], 'remove'),
		start: (container: string) => d(['start', checkName(container, 'start')]),
		restart: (container: string) => d(['restart', checkName(container, 'restart')]),
		stop: (container: string) => d(['stop', checkName(container, 'stop')]),

		get_info: (container: string) => d(['inspect', checkName(container, 'get_info'), '--format={{json .}}'], 'get_info').stdout,
		get_state: (container: string) => d(['inspect', '-f', '{{.State.Status}}', checkName(container, 'get_state')], 'get_state').stdout,
		get_resources: (container: string) => d(['stats', checkName(container, 'get_resources'), '--no-stream'], 'get_resources'),
		get_console_logs: (container: string, limit: number = 200) =>
			d(['logs', '--tail', String(Math.min(Math.max(Number(limit) || 200, 1), 2000)), checkName(container, 'get_console_logs')], 'get_console_logs'),

		get_file_content: (container: string, p: string) => d(['exec', checkName(container, 'get_file_content'), 'cat', checkPath(p, 'get_file_content')], 'get_file_content'),
		rmfile: (container: string, p: string) => d(['exec', checkName(container, 'rmfile'), 'rm', '-f', checkPath(p, 'rmfile')], 'rmfile'),
		mvfile: (container: string, from: string, to: string) => d(['exec', checkName(container, 'mvfile'), 'mv', checkPath(from, 'mvfile'), checkPath(to, 'mvfile')], 'mvfile'),
		// edit_file: content travels over stdin (docker exec -i), the path goes
		// through checkPath before it can get anywhere near `sh -c`. The previous
		// version interpolated an arbitrary path into the shell AND dropped the
		// content, so it wrote an empty file and was injectable.
		edit_file: (container: string, p: string, content: string) => {
			const path = checkPath(p, 'edit_file');
			if (typeof content !== 'string') throw new RuntimeError('docker.edit_file: content must be a string');
			if (content.length > FILE_CONTENT_CAP) throw new RuntimeError(`docker.edit_file: content exceeds ${FILE_CONTENT_CAP} bytes`);
			const policy = gate('edit_file');
			return drun(['exec', '-i', checkName(container, 'edit_file'), 'sh', '-c', `cat > ${path}`], policy.host, content);
		},

		mkdir: (container: string, p: string, recursive?: boolean) => d(['exec', checkName(container, 'mkdir'), 'mkdir', ...(recursive ? ['-p'] : []), checkPath(p, 'mkdir')], 'mkdir'),
		rmdir: (container: string, p: string, force?: boolean) => d(['exec', checkName(container, 'rmdir'), 'rm', ...(force ? ['-rf'] : ['-r']), checkPath(p, 'rmdir')], 'rmdir'),
		lsdir: (container: string, p: string, recursive?: boolean) => d(['exec', checkName(container, 'lsdir'), 'ls', ...(recursive ? ['-R'] : []), checkPath(p, 'lsdir')], 'lsdir'),
		mvdir: (container: string, from: string, to: string) => d(['exec', checkName(container, 'mvdir'), 'mv', checkPath(from, 'mvdir'), checkPath(to, 'mvdir')], 'mvdir'),

		recreate: (container: string) => {
			const policy = gate('recreate');
			const name = checkName(container, 'recreate');
			const raw = d(['inspect', name, '--format={{json .}}'], 'recreate');
			// `docker inspect` nests everything (Config/HostConfig): the old code
			// read top-level keys, always got undefined and silently recreated
			// the container from the DEFAULT image with no ports
			let config: DockerConfig = {};
			try {
				const info = JSON.parse(raw.stdout) as {
					Config?: { Image?: string };
					HostConfig?: {
						Memory?: number;
						NanoCpus?: number;
						PortBindings?: Record<string, { HostPort?: string }[]>;
						Binds?: string[];
					};
				};
				const ports = new Set<number>();
				for (const bindings of Object.values(info.HostConfig?.PortBindings ?? {})) {
					for (const b of bindings ?? []) {
						const p = Number(b?.HostPort);
						if (Number.isInteger(p) && p > 0) ports.add(p);
					}
				}
				config = {
					image: info.Config?.Image,
					ports: [...ports],
					memory: info.HostConfig?.Memory ? `${Math.max(1, Math.round(info.HostConfig.Memory / 1024 / 1024))}m` : undefined,
					cpu: info.HostConfig?.NanoCpus ? info.HostConfig.NanoCpus / 1e9 : undefined,
					volumes: (info.HostConfig?.Binds ?? [])
						.map((bind) => {
							const [host, target] = bind.split(':');
							return { host, container: target };
						})
						.filter((v) => Boolean(v.host) && Boolean(v.container))
				};
			} catch {
				/* keep empty: buildCreateArgs falls back to defaultImage below */
			}
			if (!config.image) {
				throw new RuntimeError(`docker.recreate: could not read the image of '${name}' from docker inspect`);
			}
			// validate the WHOLE create (image, ports, volumes, extra args) and the
			// cap BEFORE anything is destroyed: a refused port must not cost the
			// operator their container
			const args = buildCreateArgs(name, config, policy, 'recreate');
			const existing = d(['ps', '-a', '-q'], 'recreate')
				.stdout.split('\n')
				.filter((s) => s.length > 0).length;
			// this container is part of `existing` and is about to be replaced, so
			// the count only breaks the cap when it is already ABOVE it
			if (existing > (policy.maxContainers ?? 100)) throw new RuntimeError(`docker.recreate: container limit reached (${policy.maxContainers})`);
			d(['stop', name], 'recreate');
			d(['rm', name], 'recreate');
			return d(args, 'recreate');
		},

		edit: (container: string, config: DockerConfig) => {
			const policy = gate('edit');
			const name = checkName(container, 'edit');
			if (config?.image) {
				// same rule as recreate: nothing dies until every check passed
				const args = buildCreateArgs(name, config, policy, 'edit');
				const existing = d(['ps', '-a', '-q'], 'edit')
					.stdout.split('\n')
					.filter((s) => s.length > 0).length;
				if (existing >= (policy.maxContainers ?? 100)) throw new RuntimeError(`docker.edit: container limit reached (${policy.maxContainers})`);
				d(['stop', name], 'edit');
				d(['rm', name], 'edit');
				return d(args, 'edit');
			}
			return { message: 'edit without image replacement not fully supported' };
		}
	};
}
