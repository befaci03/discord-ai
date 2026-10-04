// Runtime-toggle persistence: modules/config.json.
// The dashboard's enable/disable switches are runtime-only, so without this
// file every restart would undo them. Stored separately from config.toml so
// the dashboard never rewrites the user's hand-written config.
//
// Shape (validated on load, length-capped on save):
// {
//   "tools":     { "<name>": true|false },
//   "skills":    { "<name>": true|false },
//   "addons":    { "<name>": true|false },
//   "functions": { "<fn name>": true|false }  (per addon function)
// }
// Every entry is a pure runtime override: nothing here disables loading, it
// only sets the initial runtime state after the registries finish loading.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, statSync } from "node:fs";
import * as path from "node:path";

const FILE_NAME = "config.json";
const MAX_FILE_BYTES = 64_000; // toggles are tiny; anything bigger is abuse/corruption
const MAX_ENTRIES_PER_KIND = 512;
const NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

/** The persisted shape. Only entries whose value differs from "enabled by default" are stored. */
export interface ToggleFile {
	tools: Record<string, boolean>;
	skills: Record<string, boolean>;
	addons: Record<string, boolean>;
	/** per addon-function overrides (optional: older files have no section) */
	functions?: Record<string, boolean>;
}

/** Where the toggle file lives (project root /modules/config.json). */
export function toggleFilePath(): string {
	return path.join(process.cwd(), "modules", FILE_NAME);
}

function validSection(raw: unknown): Record<string, boolean> {
	const out: Record<string, boolean> = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (NAME_RE.test(k) && typeof v === "boolean") out[k] = v;
	}
	return out;
}

/** Read + validate. Corrupt or oversized files are ignored (fresh start), never fatal. */
export function loadToggles(file: string = toggleFilePath()): ToggleFile {
	const empty: ToggleFile = { tools: {}, skills: {}, addons: {}, functions: {} };
	if (!existsSync(file)) return empty;
	try {
		if (statSync(file).size > MAX_FILE_BYTES) {
			console.warn(`[toggles] '${file}' is suspiciously large, ignoring it`);
			return empty;
		}
		const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
		return {
			tools: validSection(parsed.tools),
			skills: validSection(parsed.skills),
			addons: validSection(parsed.addons),
			functions: validSection(parsed.functions),
		};
	} catch (err) {
		console.warn(`[toggles] ignoring corrupt '${file}': ${(err as Error).message}`);
		return empty;
	}
}

/**
 * Atomic write: tmp file + rename in the same directory. A crash mid-write
 * leaves the old file intact instead of a truncated one.
 */
export function saveToggles(toggles: ToggleFile, file: string = toggleFilePath()): void {
	const section = (m: Record<string, boolean>): Record<string, boolean> => {
		// keep the file small and reviewable: only overrides belong here
		const out: Record<string, boolean> = {};
		for (const [k, v] of Object.entries(m)) {
			if (NAME_RE.test(k) && typeof v === "boolean") out[k] = v;
		}
		return out;
	};
	const data = JSON.stringify(
		{ tools: section(toggles.tools), skills: section(toggles.skills), addons: section(toggles.addons), functions: section(toggles.functions ?? {}) },
		null,
		"\t",
	);
	if (Buffer.byteLength(data, "utf-8") > MAX_FILE_BYTES) {
		throw new Error(`toggle file would exceed ${MAX_FILE_BYTES} bytes, refusing to write`);
	}
	mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, data, { encoding: "utf-8", mode: 0o600 });
		renameSync(tmp, file);
	} catch (err) {
		try { unlinkSync(tmp); } catch { /* nothing to clean */ }
		throw err;
	}
}
