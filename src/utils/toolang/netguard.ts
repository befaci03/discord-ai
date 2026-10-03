/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// Outbound network policy for TooLang builtins (SSRF / DNS rebinding defense)

export interface HttpPolicy {
	/** allowlist of hosts; empty/undefined = all allowed */
	allowedHosts?: string[];
	/** blocklist of hosts, always wins over the allowlist */
	blockedHosts?: string[];
	/** block private/internal ranges (127.0.0.0/8, 10/8, 172.16/12, 192.168/16, ::1, etc.) */
	blockPrivate?: boolean;
	maxResponseBytes?: number;
	timeoutMs?: number;
	allowedMethods?: string[];
}

const PRIVATE_HOST_PATTERNS = [
	/^localhost$/i,
	/^127\./,
	/^10\./,
	/^192\.168\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^169\.254\./,
	/^0\./,
	/\.local$/i,
	/\.internal$/i,
	/^\[?::1\]?$/,
	/^\[?fc|fd/i, // ipv6 unique local
	/^\[?fe80/i, // ipv6 link-local
];

/** Decide if a hostname may be contacted. Blocklist wins, then private ranges, then allowlist. */
export function isHostAllowed(hostname: string, policy: HttpPolicy): boolean {
	const host = hostname.toLowerCase();
	for (const blocked of policy.blockedHosts ?? []) {
		if (matchHost(host, blocked.toLowerCase())) return false;
	}
	if (policy.blockPrivate) {
		for (const rx of PRIVATE_HOST_PATTERNS) {
			if (rx.test(host)) return false;
		}
	}
	if (policy.allowedHosts && policy.allowedHosts.length > 0) {
		return policy.allowedHosts.some((allowed) => matchHost(host, allowed.toLowerCase()));
	}
	return true;
}

function matchHost(host: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) || host === pattern.slice(2);
	if (pattern.startsWith(".")) return host.endsWith(pattern);
	return host === pattern;
}
