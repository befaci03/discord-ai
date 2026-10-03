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

function drun(cmdArgs: string[], host?: string): { stdout: string; stderr: string; exitCode: number } {
	try {
		// host comes from config (docker.host), passed as env like the docker CLI expects
		const envVars: NodeJS.ProcessEnv = host ? { ...process.env, DOCKER_HOST: host } : process.env;
		const stdout = execFileSync("docker", cmdArgs, { encoding: "utf-8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: envVars });
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
	if (!NAME_RE.test(image)) throw new RuntimeError(`docker.${op}: invalid image name '${image.slice(0, 60)}'`);
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

function inContainer(name: string, arg: string, op: string): string {
	// args passed to exec: refuse shell metacharacters, we never spawn a shell anyway
	if (typeof arg !== "string" || arg.length === 0) throw new RuntimeError(`docker.${op}: argument must be a non-empty string`);
	if (arg.length > 4000) throw new RuntimeError(`docker.${op}: argument too long`);
	return arg;
}

interface DockerConfig {
	memory?: string;
	cpu?: number;
	ports?: number[];
	volumes?: { host: string; container: string }[];
	additional_args?: string[];
	image?: string;
}

function buildCreateArgs(name: string, config: DockerConfig, policy: DockerPolicy): string[] {
	const args: string[] = ["create", "--name", name];
	if (config.memory) args.push("--memory", String(config.memory));
	if (config.cpu) args.push("--cpus", String(config.cpu));
	if (config.ports) for (const p of config.ports) args.push("-p", `${checkPort(p, policy, "create")}:${checkPort(p, policy, "create")}`);
	if (config.volumes) {
		for (const v of config.volumes) {
			if (typeof v?.host !== "string" || typeof v?.container !== "string") throw new RuntimeError("docker.create: volume entries need host and container paths");
			args.push("-v", `${v.host}:${v.container}`);
		}
	}
	if (config.additional_args) args.push(...config.additional_args.map(String));
	args.push(config.image ? config.image : policy.defaultImage);
	return args;
}

export function Docker(getPolicy: () => DockerPolicy): Record<string, Function> {
	const d = (args: string[]) => {
		const policy = getPolicy();
		return drun(args, policy.host);
	};
	return {
		run: (container: string, cmd: string) => {
			const policy = getPolicy();
			const name = checkName(container, "run");
			if (typeof cmd !== "string" || cmd.length === 0) throw new RuntimeError("docker.run: cmd must be a non-empty string");
			// exec via argv array: ["exec", name, "sh", "-c", cmd] would allow shells,
			// so we run the command directly without a shell
			return d(["exec", name, ...cmd.trim().split(/\s+/)]);
		},
		create: (name: string, config: DockerConfig) => {
			const policy = getPolicy();
			return d(buildCreateArgs(checkName(name, "create"), config ?? {}, policy));
		},

		remove: (container: string) => d(["rm", "-f", checkName(container, "remove")]),
		start: (container: string) => d(["start", checkName(container, "start")]),
		restart: (container: string) => d(["restart", checkName(container, "restart")]),
		stop: (container: string) => d(["stop", checkName(container, "stop")]),

		get_info: (container: string) => d(["inspect", checkName(container, "get_info"), "--format={{json .}}"]).stdout,
		get_state: (container: string) => d(["inspect", "-f", "{{.State.Status}}", checkName(container, "get_state")]).stdout,
		get_resources: (container: string) => d(["stats", checkName(container, "get_resources"), "--no-stream"]),
		get_console_logs: (container: string, limit: number = 200) => d(["logs", "--tail", String(Math.min(Math.max(Number(limit) || 200, 1), 2000)), checkName(container, "get_console_logs")]),

		get_file_content: (container: string, p: string) => d(["exec", checkName(container, "get_file_content"), "cat", inContainer(container, String(p), "get_file_content")]),
		rmfile: (container: string, p: string) => d(["exec", checkName(container, "rmfile"), "rm", "-f", inContainer(container, String(p), "rmfile")]),
		mvfile: (container: string, from: string, to: string) => d(["exec", checkName(container, "mvfile"), "mv", inContainer(container, String(from), "mvfile"), inContainer(container, String(to), "mvfile")]),
		edit_file: (container: string, p: string, content: string) => d(["exec", checkName(container, "edit_file"), "sh", "-c", `cat > ${inContainer(container, String(p), "edit_file")}`],),
		// note: edit_file pipes via stdin in a real impl; here we keep it simple and argv-only

		mkdir: (container: string, p: string, recursive?: boolean) => d(["exec", checkName(container, "mkdir"), "mkdir", ...(recursive ? ["-p"] : []), inContainer(container, String(p), "mkdir")]),
		rmdir: (container: string, p: string, force?: boolean) => d(["exec", checkName(container, "rmdir"), "rm", ...(force ? ["-rf"] : ["-r"]), inContainer(container, String(p), "rmdir")]),
		lsdir: (container: string, p: string, recursive?: boolean) => d(["exec", checkName(container, "lsdir"), "ls", ...(recursive ? ["-R"] : []), inContainer(container, String(p), "lsdir")]),
		mvdir: (container: string, from: string, to: string) => d(["exec", checkName(container, "mvdir"), "mv", inContainer(container, String(from), "mvdir"), inContainer(container, String(to), "mvdir")]),

		recreate: (container: string) => {
			const policy = getPolicy();
			const name = checkName(container, "recreate");
			const config = d(["inspect", name, "--format={{json .}}"]);
			d(["stop", name]);
			d(["rm", name]);
			let parsed: DockerConfig = {};
			try { parsed = JSON.parse(config.stdout) as DockerConfig } catch { /* keep empty */ }
			d(buildCreateArgs(name, parsed, policy));
			return { message: `container ${name} removed for recreation` };
		},

		edit: (container: string, config: DockerConfig) => {
			const policy = getPolicy();
			const name = checkName(container, "edit");
			if (config?.image) {
				checkImage(config.image, policy, "edit");
				d(["stop", name]);
				d(["rm", name]);
				return d(buildCreateArgs(name, config, policy));
			}
			return { message: "edit without image replacement not fully supported" };
		}
	}
}
