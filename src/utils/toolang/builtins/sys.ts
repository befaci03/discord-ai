/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// TooLang sys module: read-only host info. No writes, no subprocesses,
// nothing that can be used as a pry bar.

import * as os from "node:os";
import { RuntimeError } from "../evaluator.js";

export function sys(): Record<string, unknown> {
	return {
		hostname: () => os.hostname(),
		platform: () => process.platform,
		arch: () => process.arch,
		nodeVersion: () => process.version,
		uptime: () => Math.floor(process.uptime()),
		loadavg: () => os.loadavg(),
		totalMem: () => os.totalmem(),
		freeMem: () => os.freemem(),
		cpuCount: () => os.cpus().length,
		cpuModel: () => os.cpus()[0]?.model ?? "unknown",
		env: (name: unknown) => {
			// intentionally only exposes allowlisted-ish lookups by exact name,
			// never dumps the whole environment
			const key = String(name ?? "");
			if (!/^[A-Z0-9_]{1,64}$/.test(key)) throw new RuntimeError("sys.env expects an env var name (A-Z, 0-9, _)");
			return process.env[key] ?? null;
		},
	};
}
