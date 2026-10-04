/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// Docker builtin for TooLang.
// Docker itself is the attack surface here: names, images and paths all go
// through validation before touching the CLI. fuck docker but better than hell lmao

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, type Stats } from 'node:fs';
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
	/**
	 * store behind agent volumes: <sandbox>/.docker-vols. A volume id becomes
	 * <volumeRoot>/<id>, jailed in there and allowed WITHOUT an
	 * allowed_volume_paths entry (the sandbox is the trust root).
	 */
	volumeRoot?: string;
	/** sandbox root (config agent.toolang.fs.root): docker.cp jail for host-side paths */
	fsRoot?: string;
	/** max bytes for a file crossing docker.cp (config agent.toolang.fs.maxFileSize) */
	fsMaxFileSize?: number;
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

/**
 * Quote-aware argv split for docker.run: single/double quotes group words and
 * backslash escapes the next char, then the argv goes to exec as-is. NO shell
 * is spawned either way, this only decides where one argument ends.
 * The old whitespace-only split chopped `sh -c 'echo "a b"'` into pieces and
 * the container's shell answered with "unterminated quoted string".
 */
export function splitArgv(cmd: string): string[] {
	const out: string[] = [];
	let cur = '';
	let started = false;
	let quote: string | null = null;
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (quote !== null) {
			if (ch === quote) {
				quote = null;
				continue;
			}
			// inside double quotes a backslash escapes the next char; single
			// quotes keep everything literal, exactly like sh
			if (quote === '"' && ch === '\\' && i + 1 < cmd.length) {
				cur += cmd[++i];
				continue;
			}
			cur += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			started = true;
			continue;
		}
		if (ch === '\\' && i + 1 < cmd.length) {
			cur += cmd[++i];
			started = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (started) {
				out.push(cur);
				cur = '';
				started = false;
			}
			continue;
		}
		cur += ch;
		started = true;
	}
	if (quote !== null) throw new RuntimeError(`docker.run: unbalanced ${quote} quote in command (close it, or escape it with a backslash)`);
	if (started) out.push(cur);
	return out;
}

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

/** Container mount point: absolute, no `..`, same charset as checkPath. */
function checkContainerPath(container: unknown, op: string): string {
	const c = String(container ?? '');
	if (c.length === 0 || c.length > 1000 || !CONTAINER_PATH_RE.test(c) || c.includes('..')) {
		throw new RuntimeError(`docker.${op}: container path '${c.slice(0, 60)}' must be absolute (letters, digits, _ . - / only, no '..')`);
	}
	return c;
}

/**
 * Resolve a docker.cp host-side path inside the SANDBOX root (config
 * agent.toolang.fs.root): relative paths resolve inside it, absolute ones must
 * already be under it, and no ancestor may be a symlink pointing out of it.
 * Same jail rules as the fs builtin, so both sides of a copy agree.
 */
function resolveSandboxPath(p: string, policy: DockerPolicy, op: string): string {
	const root = typeof policy.fsRoot === 'string' && policy.fsRoot ? path.resolve(policy.fsRoot) : '';
	if (!root) throw new RuntimeError(`docker.${op}: sandbox file access is unavailable (no fs root configured)`);
	if (typeof p !== 'string' || p.length === 0) throw new RuntimeError(`docker.${op}: sandbox path must be a non-empty string`);
	if (p.includes('\0')) throw new RuntimeError(`docker.${op}: null bytes are not allowed in paths`);
	const abs = path.resolve(root, p);
	const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
	if (!abs.startsWith(rootWithSep)) {
		throw new RuntimeError(`docker.${op}: sandbox path '${p.slice(0, 60)}' must stay inside '${root}'`);
	}
	// walk existing ancestors: a symlinked dir pointing outside would move the
	// copy across the jail boundary
	let cur = abs;
	while (cur.startsWith(rootWithSep)) {
		let st: Stats;
		try {
			st = lstatSync(cur);
		} catch {
			cur = path.dirname(cur);
			continue;
		}
		if (st.isSymbolicLink()) {
			const target = realpathSync(cur);
			if (!target.startsWith(rootWithSep)) throw new RuntimeError(`docker.${op}: '${path.relative(root, cur)}' is a symlink pointing outside the sandbox`);
		}
		cur = path.dirname(cur);
	}
	return abs;
}

/** Volume ids are ONE path segment: no slashes, no leading dot (so no `..`). */
const VOLUME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * Resolve an agent volume id to `<volumeRoot>/<volume_id>` (the sandbox's
 * .docker-vols store) and make sure the directory exists, so docker does not
 * create it root-owned behind our back. The id is a single path segment by
 * construction and the store is realpath'd before joining, so neither `../`
 * nor a symlinked store can aim this mount at the host.
 */
function resolveAgentVolume(idRaw: unknown, policy: DockerPolicy, op: string): string {
	const id = String(idRaw ?? '');
	if (!VOLUME_ID_RE.test(id)) {
		throw new RuntimeError(`docker.${op}: invalid volume id '${id.slice(0, 40)}' (letters, digits, _ . - and dots, 1..64 chars, no slashes)`);
	}
	const root = typeof policy.volumeRoot === 'string' ? policy.volumeRoot.trim() : '';
	if (!root) {
		throw new RuntimeError(`docker.${op}: agent volumes are unavailable (no .docker-vols root configured)`);
	}
	try {
		mkdirSync(root, { recursive: true });
		const realRoot = realpathSync(root);
		const dir = path.join(realRoot, id);
		if (!dir.startsWith(realRoot + path.sep)) throw new Error('volume escaped its store');
		mkdirSync(dir, { recursive: true });
		return dir;
	} catch (err) {
		throw new RuntimeError(`docker.${op}: could not prepare volume '${id}': ${(err as Error).message}`);
	}
}

/**
 * One `-v host:container` bind. Two forms:
 * - `{ volume, container }`: an agent volume id, resolved into
 *   <volumeRoot>/<id>. Jailed in the sandbox store, so no allowlist entry.
 * - `{ host, container }`: a real host path. The host side is the dangerous
 *   one: without an allowlist the llm could mount /etc (or the whole disk)
 *   into a container and read it back through docker.get_file_content. So:
 *   resolve the path, then demand it sits inside
 *   [docker].allowed_volume_paths OR inside the .docker-vols store (binds
 *   THIS code created must survive recreate/edit re-validation).
 */
function checkVolumeBind(v: { host?: unknown; container?: unknown; volume?: unknown }, policy: DockerPolicy, op: string): string {
	if (!v || typeof v.container !== 'string') {
		throw new RuntimeError(`docker.${op}: volume entries need a container path and either a volume id or a host path`);
	}
	const container = checkContainerPath(v.container, op);
	// agent volume: id -> <sandbox>/.docker-vols/<id>, created on the spot.
	// A GIVEN volume key is always validated (an empty id says "invalid volume
	// id", not "no volume given"), and whatever it resolves to stays jailed
	if (v.volume !== undefined && v.volume !== null) {
		return `${resolveAgentVolume(v.volume, policy, op)}:${container}`;
	}
	if (typeof v.host !== 'string') {
		throw new RuntimeError(`docker.${op}: volume entries need a host path or a volume id (plus the container path)`);
	}
	// resolve first, so a /data/../etc trick cannot slide past the prefix check
	const host = path.resolve(v.host);
	const roots = (policy.allowedVolumePaths ?? []).map((r) => path.resolve(String(r)));
	if (roots.some((root) => host === root || host.startsWith(root + path.sep))) return `${host}:${container}`;
	// our own store: recreate/edit read these binds back from docker inspect
	const store = typeof policy.volumeRoot === 'string' && policy.volumeRoot ? path.resolve(policy.volumeRoot) : '';
	if (store && (host === store || host.startsWith(store + path.sep))) return `${host}:${container}`;
	throw new RuntimeError(
		roots.length > 0
			? `docker.${op}: host path '${host.slice(0, 80)}' is outside [docker].allowed_volume_paths`
			: `docker.${op}: host mounts are refused (set [docker].allowed_volume_paths to the paths the llm may mount, or pass a volume id: it resolves to sandbox/.docker-vols/<id>)`
	);
}
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

/** One `-v host:container` entry of docker.create/edit/recreate. */
interface DockerVolumeBind {
	host?: string;
	container: string;
	/** agent volume id: resolved to <volumeRoot>/<id> instead of a host path */
	volume?: string;
}

interface DockerConfig {
	memory?: string;
	cpu?: number;
	ports?: number[];
	volumes?: DockerVolumeBind[];
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

	/**
	 * Read an existing container's create config back from `docker inspect`
	 * (image, ports, memory, cpus, binds). Shared by recreate and attach.
	 * `docker inspect` nests everything under Config/HostConfig: reading
	 * top-level keys used to return undefined and silently recreate the
	 * container from the DEFAULT image with no ports.
	 */
	const inspectConfig = (op: string, name: string): DockerConfig => {
		const raw = d(['inspect', name, '--format={{json .}}'], op);
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
			/* keep empty: the image check below reports it */
		}
		if (!config.image) {
			// stderr tells "no such container" from "docker not running"
			const detail = raw.stderr ? `: ${raw.stderr.slice(0, 120)}` : '';
			throw new RuntimeError(`docker.${op}: could not read the image of '${name}' from docker inspect${detail}`);
		}
		return config;
	};

	/**
	 * The replace flow shared by recreate/edit/attach. The caller already ran
	 * buildCreateArgs (the WHOLE create is validated), so here we only count,
	 * swap and bring it back up: stop -> rm -> create -> start. Without the
	 * final start a "recreated" container came back dead, which nobody asked for.
	 */
	const replace = (op: string, name: string, args: string[]): { stdout: string; stderr: string; exitCode: number } => {
		const policy = gate(op);
		const existing = d(['ps', '-a', '-q'], op)
			.stdout.split('\n')
			.filter((s) => s.length > 0).length;
		// the container being replaced counts in `existing` and is about to be
		// removed, so the cap only breaks when it is already ABOVE the limit
		if (existing > (policy.maxContainers ?? 100)) throw new RuntimeError(`docker.${op}: container limit reached (${policy.maxContainers})`);
		d(['stop', name], op);
		d(['rm', name], op);
		const made = d(args, op);
		if (made.exitCode !== 0) return made;
		return d(['start', name], op);
	};

	return {
		// read-only overview: name, image and status of every container
		list: () => d(['ps', '-a', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}'], 'list'),
		run: (container: string, cmd: string) => {
			gate('run'); // fail fast, before checkName/argv work
			const name = checkName(container, 'run');
			if (typeof cmd !== 'string' || cmd.length === 0) throw new RuntimeError('docker.run: cmd must be a non-empty string');
			// exec via argv array (quotes only group words, no shell is spawned):
			// ["exec", name, "sh", "-c", cmd] would allow shells on OUR side
			const argv = splitArgv(cmd);
			if (argv.length === 0) throw new RuntimeError('docker.run: cmd must contain a command');
			return d(['exec', name, ...argv], 'run');
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

		/**
		 * Copy ONE file between the sandbox and a container (`docker cp`, argv
		 * only). The direction comes from the argument shapes: the absolute
		 * side is the container path, the other side is relative to the
		 * sandbox root (jailed by resolveSandboxPath). Sizes crossing the
		 * boundary are capped by fs.maxFileSize.
		 */
		cp: (container: string, source: string, destination: string) => {
			const policy = gate('cp');
			const name = checkName(container, 'cp');
			const src = typeof source === 'string' ? source : '';
			const dst = typeof destination === 'string' ? destination : '';
			if (src.length === 0 || dst.length === 0) throw new RuntimeError('docker.cp: source and destination must be non-empty strings');
			const srcAbsolute = src.startsWith('/');
			const dstAbsolute = dst.startsWith('/');
			if (srcAbsolute === dstAbsolute) {
				throw new RuntimeError(
					srcAbsolute
						? 'docker.cp: both sides are absolute; the sandbox side must be relative to the sandbox root (e.g. site/index.html)'
						: 'docker.cp: no container path given; the container side must be absolute (e.g. /usr/share/nginx/html/index.html)'
				);
			}
			const cap = policy.fsMaxFileSize ?? 1_000_000;
			if (srcAbsolute) {
				// container -> sandbox
				const cpath = checkContainerPath(src, 'cp');
				const host = resolveSandboxPath(dst, policy, 'cp');
				mkdirSync(path.dirname(host), { recursive: true });
				const res = d(['cp', `${name}:${cpath}`, host], 'cp');
				if (res.exitCode !== 0) return res;
				// the container could hand back a multi-GB file: cap what lands in
				// the sandbox, and take it back out when it overflowed
				let size = 0;
				try {
					size = statSync(host).size;
				} catch {
					return res; /* stat hiccup after a successful copy: keep the file */
				}
				if (size > cap) {
					rmSync(host, { force: true });
					throw new RuntimeError(`docker.cp: copied file is too large (${size} > ${cap} bytes)`);
				}
				return res;
			}
			// sandbox -> container
			const cpath = checkContainerPath(dst, 'cp');
			const host = resolveSandboxPath(src, policy, 'cp');
			if (existsSync(host)) {
				const size = statSync(host).size;
				if (size > cap) throw new RuntimeError(`docker.cp: file is too large (${size} > ${cap} bytes)`);
			}
			return d(['cp', host, `${name}:${cpath}`], 'cp');
		},

		recreate: (container: string) => {
			const policy = gate('recreate');
			const name = checkName(container, 'recreate');
			const config = inspectConfig('recreate', name);
			// validate the WHOLE create (image, ports, volumes, extra args)
			// BEFORE anything is destroyed: a refused port must not cost the
			// operator their container
			const args = buildCreateArgs(name, config, policy, 'recreate');
			return replace('recreate', name, args);
		},

		edit: (container: string, config: DockerConfig) => {
			const policy = gate('edit');
			const name = checkName(container, 'edit');
			if (config?.image) {
				// same rule as recreate: nothing dies until every check passed
				const args = buildCreateArgs(name, config, policy, 'edit');
				return replace('edit', name, args);
			}
			return { message: 'edit without image replacement not fully supported' };
		},

		/**
		 * Mount an AGENT VOLUME (<sandbox>/.docker-vols/<id>) into an EXISTING
		 * container: read its config back, add the bind, then the same
		 * validate-before-destroy replace flow as recreate, finished with a
		 * start so the container comes back up with the volume attached.
		 */
		attach: (container: string, volume: string, containerPath: string) => {
			const policy = gate('attach');
			const name = checkName(container, 'attach');
			const target = checkContainerPath(containerPath, 'attach');
			// fail fast: a bad volume id dies here, before docker is called at all
			resolveAgentVolume(volume, policy, 'attach');
			const config = inspectConfig('attach', name);
			const existing = config.volumes ?? [];
			if (existing.some((b) => b.container === target)) {
				throw new RuntimeError(`docker.attach: '${name}' already has a mount at '${target}'`);
			}
			config.volumes = [...existing, { volume, container: target }];
			const args = buildCreateArgs(name, config, policy, 'attach');
			return replace('attach', name, args);
		},

		/**
		 * Drop an AGENT VOLUME mount again: identify it by its id (the same
		 * single argument used to mount it), read the config back, drop every
		 * bind pointing at <volumeRoot>/<id> (optionally only the one at
		 * `containerPath`), then the usual validate-before-destroy replace
		 * finished with a start so the container comes back up unmounted.
		 */
		detach: (container: string, volume: string, containerPath?: string) => {
			const policy = gate('detach');
			const name = checkName(container, 'detach');
			const hostDir = resolveAgentVolume(volume, policy, 'detach');
			const target = typeof containerPath === 'string' && containerPath.trim() ? checkContainerPath(containerPath, 'detach') : '';
			const config = inspectConfig('detach', name);
			const existing = config.volumes ?? [];
			const kept = existing.filter((b) => !(b.host === hostDir && (target === '' || b.container === target)));
			if (kept.length === existing.length) {
				throw new RuntimeError(`docker.detach: volume '${volume}' is not mounted on '${name}'${target ? ` at '${target}'` : ''}`);
			}
			config.volumes = kept;
			const args = buildCreateArgs(name, config, policy, 'detach');
			return replace('detach', name, args);
		}
	};
}
