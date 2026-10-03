/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// TooLang node module: guarded child_process + bcrypt helpers

import { execFileSync } from "node:child_process";
import { RuntimeError } from "../evaluator.js";

export interface NodePolicy {
	/** commands the interpreter refuses to spawn */
	deniedCommands?: string[];
	/** allowlist; empty/undefined = all (minus denied) */
	allowedCommands?: string[];
	timeoutMs?: number;
	maxBuffer?: number;
	enabled?: boolean;
}

const DEFAULT_DENIED = ["sudo", "su", "doas", "shutdown", "reboot", "halt", "poweroff", "mkfs", "dd", "passwd", "chown", "chmod", "curl", "wget", "nc", "ncat", "telnet", "ssh", "eval"];

export function runCommand(cmd: string, policy: NodePolicy): { stdout: string; stderr: string; exitCode: number } {
	if (policy.enabled === false) throw new RuntimeError("node.child_process is disabled in config");
	if (typeof cmd !== "string" || cmd.trim().length === 0) throw new RuntimeError("child_process.run expects a non-empty string command");
	if (cmd.length > 2000) throw new RuntimeError("command too long (max 2000 chars)");

	// first token is the binary
	const binary = cmd.trim().split(/\s+/)[0];
	const denied = policy.deniedCommands ?? DEFAULT_DENIED;
	if (denied.includes(binary)) throw new RuntimeError(`command '${binary}' is denied by policy`);
	if (policy.allowedCommands && policy.allowedCommands.length > 0 && !policy.allowedCommands.includes(binary)) {
		throw new RuntimeError(`command '${binary}' is not in the allowed list`);
	}

	try {
		// shell: false so the command is split safely, no injection into a shell
		const parts = cmd.trim().split(/\s+/);
		const stdout = execFileSync(parts[0], parts.slice(1), {
			encoding: "utf-8",
			timeout: policy.timeoutMs ?? 30_000,
			maxBuffer: policy.maxBuffer ?? 1024 * 1024,
			shell: false,
		});
		return { stdout, stderr: "", exitCode: 0 }
	} catch (err: unknown) {
		const e = err as { stdout?: string; stderr?: string; status?: number; message?: string };
		return { stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "", exitCode: e.status ?? 1 }
	}
}

export function NodeJS(cfg?: Record<string, unknown>): Record<string, Record<string, Function>> {
	const raw = (cfg && typeof cfg.node === "object" ? cfg.node : {}) as Record<string, unknown>;
	const policy: NodePolicy = {
		deniedCommands: Array.isArray(raw.deniedCommands) ? raw.deniedCommands.map(String) : DEFAULT_DENIED,
		allowedCommands: Array.isArray(raw.allowedCommands) ? raw.allowedCommands.map(String) : undefined,
		timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : 30_000,
		maxBuffer: typeof raw.maxBuffer === "number" ? raw.maxBuffer : 1024 * 1024,
		enabled: raw.enabled !== false,
	};
	return {
		child_proc: {
			run: (cmd: string) => runCommand(cmd, policy),
		},
		// full alias, docs mention both
		child_process: {
			run: (cmd: string) => runCommand(cmd, policy),
		},
	};
}
