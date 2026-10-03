// Addon registry: activates opt-in addons from addons.enabled in config.
// An addon extends the AGENT with LLM-callable functions (and optionally
// exposes TooLang modules to tool scripts). Everything runs sandboxed.

import { AppConfig } from '../utils/config.js';
import { Addon, AddonStatus, AgentFunction, ModuleError } from './types.js';
// addons live in /modules/addons (project root), NOT in src
import { GitHub } from '../../modules/addons/github.js';
import { Weather } from '../../modules/addons/weather.js';
import { Tunnel } from '../../modules/addons/tunnel.js';
import { SMTP } from '../../modules/addons/smtp.js';
import { Cron } from '../../modules/addons/cron.js';

const BUILTINS: Addon[] = [GitHub, Weather, Tunnel, SMTP, Cron];

export class AddonRegistry {
	private active = new Map<string, Addon>();
	private errors = new Map<string, string>();
	/** runtime overrides set from the dashboard (win over config at runtime) */
	private runtimeDisabled = new Set<string>();

	constructor(private config: AppConfig) {}

	/** True when the addon is active AND not disabled at runtime. */
	isEnabled(name: string): boolean {
		if (!this.active.has(name)) return false;
		return !this.runtimeDisabled.has(name);
	}

	/** Runtime toggle. Returns the new state; no-op for unknown addons. */
	setEnabled(name: string, enabled: boolean): boolean | null {
		if (!this.active.has(name)) return null;
		if (enabled) this.runtimeDisabled.delete(name);
		else this.runtimeDisabled.add(name);
		return this.isEnabled(name);
	}

	/** Names disabled at runtime only (dashboard toggles). */
	runtimeDisabledNames(): string[] {
		return [...this.runtimeDisabled];
	}

	/** True when the named agent function's owning addon is enabled right now. */
	functionEnabled(fnName: string): boolean {
		for (const [name, addon] of this.active) {
			if (addon.functions.some((f) => f.name === fnName)) return !this.runtimeDisabled.has(name);
		}
		return false;
	}

	/**
	 * Activate every addon listed in addons.enabled, and ONLY those. An
	 * [addons.<slug>] settings section never enables anything by itself: such
	 * sections outside the enabled list are reported as ignored so the
	 * operator can see the gate at work.
	 */
	async loadAll(): Promise<{ loaded: string[]; unknown: string[]; ignored: string[]; notes: string[] }> {
		const loaded: string[] = [];
		const unknown: string[] = [];
		const notes: string[] = [];
		const enabled = new Set(this.config.addons.enabled);
		const ignored = Object.keys(this.config.addons).filter((key) => key !== 'enabled' && !enabled.has(key));
		for (const name of this.config.addons.enabled) {
			const addon = BUILTINS.find((a) => a.name === name);
			if (!addon) {
				unknown.push(name);
				this.errors.set(name, 'unknown addon');
				continue;
			}
			try {
				let ok = true;
				if (addon.init) ok = await addon.init(this.config);
				if (!ok) {
					this.errors.set(name, 'not configured (missing keys/env)');
					continue;
				}
				this.active.set(addon.name, addon);
				loaded.push(addon.name);
				// optional one-liners for the startup log (e.g. the tunnel URL)
				if (typeof addon.startupNote === 'function') {
					const note = addon.startupNote();
					if (note) notes.push(note);
				}
			} catch (err) {
				this.errors.set(name, (err as Error).message);
			}
		}
		return { loaded, unknown, ignored, notes };
	}

	/** All agent functions from active + enabled addons, merged (for the LLM tool loop). */
	agentFunctions(): AgentFunction[] {
		const seen = new Set<string>();
		const out: AgentFunction[] = [];
		for (const [addonName, addon] of this.active) {
			if (this.runtimeDisabled.has(addonName)) continue;
			for (const fn of addon.functions) {
				if (seen.has(fn.name)) throw new ModuleError(`addon function name collision: '${fn.name}'`);
				seen.add(fn.name);
				out.push(fn);
			}
		}
		return out;
	}

	/** Extra top-level TooLang vars from active + enabled addons (merged), if any. */
	extraVars(): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const [addonName, addon] of this.active) {
			if (this.runtimeDisabled.has(addonName)) continue;
			for (const [mod, impl] of Object.entries(addon.modules ?? {})) {
				if (mod in out) throw new ModuleError(`addon module name collision: '${mod}'`);
				out[mod] = impl;
			}
		}
		return out;
	}

	/** Dashboard/health info. Never exposes credentials or module internals. */
	status(): AddonStatus[] {
		const statuses: AddonStatus[] = [];
		for (const name of this.config.addons.enabled) {
			const addon = this.active.get(name);
			if (addon) {
				statuses.push({
					name: addon.name,
					description: addon.description,
					functions: addon.functions.map((f) => f.name),
					configured: true,
					enabled: this.isEnabled(name)
				});
				continue;
			} else {
				statuses.push({
					name,
					description: '',
					functions: [],
					configured: false,
					error: this.errors.get(name) ?? 'inactive'
				});
			}
		}
		return statuses;
	}

	names(): string[] {
		return [...this.active.keys()];
	}

	count(): number {
		return this.active.size;
	}
}

/** List addons that exist in this build (for docs/dashboard). */
export function availableAddons(): { name: string; description: string }[] {
	return BUILTINS.map((a) => ({ name: a.name, description: a.description }));
}
