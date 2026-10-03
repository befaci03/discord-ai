/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// Docker builtin for TooLang.
// Docker itself is the attack surface here: names, images and paths all go
// through validation before touching the CLI. fuck docker but better than hell lmao

import { execFileSync } from "node:child_process";
import { RuntimeError } from "../evaluator.js";

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
}

function drun(cmdArgs: string[], host?: string, input?: string): { stdout: string; stderr: string; exitCode: number } {
	try {
		// host comes from config (docker.host), passed as env like the docker CLI expects
		const envVars: NodeJS.ProcessEnv = host ? { ...process.env, DOCKER_HOST: host } : process.env;
		const stdout = execFileSync("docker", cmdArgs, { encoding: "utf-8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: envVars, input });
		return { stdout: stdout.trim(), stderr: "", exitCode: 0 };
	} catch (err: unknown) {
		const e = err as { stdout?: string; stderr?: string; status?: number };
		return { stdout: e.stdout?.trim() ?? "", stderr: e.stderr?.trim() ?? "", exitCode: e.status ?? 1 };
	}
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function checkName(name: unknown, op: string): string {
	if (typeof name !== "string" || !NAME_RE.test(name)) throw new RuntimeError(`docker.${op}: invalid container name '${String(name).slice(0, 40)}'`);
	return name;
}

function checkImage(image: string, policy: DockerPolicy, op: string): string {
	if (typeof image !== "string" || image.length === 0 || image.length > 255 || !IMAGE_RE.test(image)) {
		throw new RuntimeError(`docker.${op}: invalid image name '${String(image).slice(0, 60)}'`);
	}
	for (const bad of policy.disallowedImages ?? []) {
		if (image === bad || image.startsWith(bad + ":") || image.startsWith(bad + "/")) {
			throw new RuntimeError(`docker.${op}: image '${image}' is disallowed`);
		}
	}
	if (policy.allowedImages && policy.allowedImages.length > 0) {
		const ok = policy.allowedImages.some((good) => image === good || image.startsWith(good + ":") || image.startsWith(good + "/"));
		if (!ok) throw new RuntimeError(`docker.${op}: image '${image}' is not in the allowed list`);
	}
	return image;
}

function checkPort(port: unknown, policy: DockerPolicy, op: string): number {
	const p = Number(port);
	if (!Number.isInteger(p) || p < 1 || p > 65535) throw new RuntimeError(`docker.${op}: invalid port ${String(port)}`);
	for (const range of policy.allowedPorts ?? []) {
		const [lo, hi] = range.split("-").map(Number);
		if (p >= (lo ?? 0) && p <= (hi ?? lo ?? 0)) return p;
	}
	throw new RuntimeError(`docker.${op}: port ${p} is outside the allowed ranges`);
}

const PATH_RE = /^\/?[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/;
/** images allow a registry/path, a tag and a digest: `host/ns/img:tag@sha256:...` */
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9_.\/:@-]{0,254}$/;
const FILE_CONTENT_CAP = 1_000_000; // bytes a tool may write into a container

/**
 * Container paths: letters, digits, _ . - / only, no `..`. Checked even for
 * the argv-only calls so every file op accepts the same charset, and strictly
 * required wherever the path ends up in a shell string (edit_file).
 */
function checkPath(p: unknown, op: string): string {
	const s = String(p ?? "");
	if (s.length === 0 || s.length > 1000 || !PATH_RE.test(s) || s.includes("..")) {
		throw new RuntimeError(`docker.${op}: invalid path '${s.slice(0, 60)}' (letters, digits, _ . - / only, no '..')`);
	}
	return s;
}

interface DockerConfig {
	memory?: string;
	cpu?: number;
	ports?: number[];
	volumes?: { host: string; container: string }[];
	additional_args?: string[];
	image?: string;
}

function buildCreateArgs(name: string, config: DockerConfig, policy: DockerPolicy, op = "create"): string[] {
	const args: string[] = ["create", "--name", name];
	if (config.memory) args.push("--memory", String(config.memory));
	if (config.cpu) args.push("--cpus", String(config.cpu));
	if (config.ports) for (const p of config.ports) args.push("-p", `${checkPort(p, policy, op)}:${checkPort(p, policy, op)}`);
	if (config.volumes) {
		for (const v of config.volumes) {
			if (typeof v?.host !== "string" || typeof v?.container !== "string") throw new RuntimeError("docker.create: volume entries need host and container paths");
			args.push("-v", `${v.host}:${v.container}`);
		}
	}
	if (config.additional_args) args.push(...config.additional_args.map(String));
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
		const policy = gate(op ?? String(args[0] ?? "run"));
		return drun(args, policy.host);
	};
	return {
		// read-only overview: name, image and status of every container
		list: () => d(["ps", "-a", "--format", "{{.Names}}\t{{.Image}}\t{{.Status}}"], "list"),
		run: (container: string, cmd: string) => {
			gate("run"); // fail fast, before checkName/argv work
			const name = checkName(container, "run");
			if (typeof cmd !== "string" || cmd.length === 0) throw new RuntimeError("docker.run: cmd must be a non-empty string");
			// exec via argv array: ["exec", name, "sh", "-c", cmd] would allow shells,
			// so we run the command directly without a shell
			return d(["exec", name, ...cmd.trim().split(/\s+/)], "run");
		},
		create: (name: string, imageOrConfig?: string | DockerConfig, maybeConfig?: DockerConfig) => {
			const policy = gate("create");
			const cname = checkName(name, "create");
			// accepts docker.create(name, { image, ... }) and the documented
			// docker.create(name, image, { ... }) shorthand
			let config: DockerConfig;
			if (imageOrConfig === undefined || imageOrConfig === null) config = {};
			else if (typeof imageOrConfig === "string") config = { ...(maybeConfig ?? {}), image: imageOrConfig };
			else if (typeof imageOrConfig === "object" && !Array.isArray(imageOrConfig)) config = imageOrConfig;
			else throw new RuntimeError("docker.create: expected (name, image, config?) or (name, config)");
			// validate inputs first (image allow/deny, ports), then check the cap
			const args = buildCreateArgs(cname, config, policy);
			const cap = policy.maxContainers ?? 100;
			const existing = d(["ps", "-a", "-q"], "create").stdout.split("\n").filter((s) => s.length > 0).length;
			if (existing >= cap) throw new RuntimeError(`docker.create: container limit reached (${cap}), remove one first`);
			return d(args, "create");
		},

		remove: (container: string) => d(["rm", "-f", checkName(container, "remove")], "remove"),
		start: (container: string) => d(["start", checkName(container, "start")]),
		restart: (container: string) => d(["restart", checkName(container, "restart")]),
		stop: (container: string) => d(["stop", checkName(container, "stop")]),

		get_info: (container: string) => d(["inspect", checkName(container, "get_info"), "--format={{json .}}"], "get_info").stdout,
		get_state: (container: string) => d(["inspect", "-f", "{{.State.Status}}", checkName(container, "get_state")], "get_state").stdout,
		get_resources: (container: string) => d(["stats", checkName(container, "get_resources"), "--no-stream"], "get_resources"),
		get_console_logs: (container: string, limit: number = 200) => d(["logs", "--tail", String(Math.min(Math.max(Number(limit) || 200, 1), 2000)), checkName(container, "get_console_logs")], "get_console_logs"),

		get_file_content: (container: string, p: string) => d(["exec", checkName(container, "get_file_content"), "cat", checkPath(p, "get_file_content")], "get_file_content"),
		rmfile: (container: string, p: string) => d(["exec", checkName(container, "rmfile"), "rm", "-f", checkPath(p, "rmfile")], "rmfile"),
		mvfile: (container: string, from: string, to: string) => d(["exec", checkName(container, "mvfile"), "mv", checkPath(from, "mvfile"), checkPath(to, "mvfile")], "mvfile"),
		// edit_file: content travels over stdin (docker exec -i), the path goes
		// through checkPath before it can get anywhere near `sh -c`. The previous
		// version interpolated an arbitrary path into the shell AND dropped the
		// content, so it wrote an empty file and was injectable.
		edit_file: (container: string, p: string, content: string) => {
			const path = checkPath(p, "edit_file");
			if (typeof content !== "string") throw new RuntimeError("docker.edit_file: content must be a string");
			if (content.length > FILE_CONTENT_CAP) throw new RuntimeError(`docker.edit_file: content exceeds ${FILE_CONTENT_CAP} bytes`);
			const policy = gate("edit_file");
			return drun(["exec", "-i", checkName(container, "edit_file"), "sh", "-c", `cat > ${path}`], policy.host, content);
		},

		mkdir: (container: string, p: string, recursive?: boolean) => d(["exec", checkName(container, "mkdir"), "mkdir", ...(recursive ? ["-p"] : []), checkPath(p, "mkdir")], "mkdir"),
		rmdir: (container: string, p: string, force?: boolean) => d(["exec", checkName(container, "rmdir"), "rm", ...(force ? ["-rf"] : ["-r"]), checkPath(p, "rmdir")], "rmdir"),
		lsdir: (container: string, p: string, recursive?: boolean) => d(["exec", checkName(container, "lsdir"), "ls", ...(recursive ? ["-R"] : []), checkPath(p, "lsdir")], "lsdir"),
		mvdir: (container: string, from: string, to: string) => d(["exec", checkName(container, "mvdir"), "mv", checkPath(from, "mvdir"), checkPath(to, "mvdir")], "mvdir"),

		recreate: (container: string) => {
			const policy = gate("recreate");
			const name = checkName(container, "recreate");
			const config = d(["inspect", name, "--format={{json .}}"], "recreate");
			d(["stop", name], "recreate");
			d(["rm", name], "recreate");
			let parsed: DockerConfig = {};
			try { parsed = JSON.parse(config.stdout) as DockerConfig } catch { /* keep empty */ }
			d(buildCreateArgs(name, parsed, policy, "recreate"), "recreate");
			return { message: `container ${name} removed for recreation` };
		},

		edit: (container: string, config: DockerConfig) => {
			const policy = gate("edit");
			const name = checkName(container, "edit");
			if (config?.image) {
				checkImage(config.image, policy, "edit");
				d(["stop", name], "edit");
				d(["rm", name], "edit");
				return d(buildCreateArgs(name, config, policy, "edit"), "edit");
			}
			return { message: "edit without image replacement not fully supported" };
		}
	}
}
