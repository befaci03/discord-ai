/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// TooLang env module: gated environment access.
// Disabled unless skills.allow_env_access is explicitly true in config.
// Even when enabled, secrets are redacted from listing.

import { RuntimeError } from "../evaluator.js";

const SECRET_HINTS = ["TOKEN", "SECRET", "KEY", "PASSWORD", "PASSWD", "CREDENTIAL"];

function isSecretName(name: string): boolean {
	return SECRET_HINTS.some((hint) => name.includes(hint));
}

export function env(allowAll: boolean): Record<string, unknown> {
	if (!allowAll) {
		// hard-off switch: every call fails with the same message, no info leak
		return new Proxy({}, {
			get() {
				throw new RuntimeError("env module is disabled (skills.allow_env_access = false in config)");
			},
		}) as Record<string, unknown>;
	}
	return {
		get: (name: unknown) => {
			const key = String(name ?? "");
			if (!/^[A-Z0-9_]{1,64}$/.test(key)) throw new RuntimeError("env.get expects an env var name (A-Z, 0-9, _)");
			return process.env[key] ?? null;
		},
		has: (name: unknown) => {
			const key = String(name ?? "");
			if (!/^[A-Z0-9_]{1,64}$/.test(key)) throw new RuntimeError("env.has expects an env var name");
			return process.env[key] !== undefined;
		},
		names: () => Object.keys(process.env).filter((k) => !isSecretName(k)).sort(),
	};
}
