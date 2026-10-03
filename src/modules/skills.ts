// Skill system: markdown files in modules/skills/<name>.md with a TOML
// frontmatter block. Skills are prompt-level capabilities: when one of their
// triggers matches what the user said, the agent gets the skill instructions
// injected into its system prompt. Complementary to tools (.tl) which are
// executable code.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import * as path from "node:path";
import * as toml from "toml";
import { LoadedSkill, ModuleError } from "./types.js";

export interface SkillMatch {
	skill: LoadedSkill;
	/** which trigger fired */
	matched: string;
}

export class SkillRegistry {
	private skills = new Map<string, LoadedSkill>();
	/** runtime overrides set from the dashboard (win over config at runtime) */
	private runtimeDisabled = new Set<string>();
	private runtimeEnabled = new Set<string>();

	constructor(private config: import("../utils/config.js").AppConfig) {}

	/** True when the skill is loaded AND not disabled (config/runtime/frontmatter). */
	isEnabled(name: string): boolean {
		if (!this.skills.has(name)) return false;
		if (this.runtimeDisabled.has(name)) return false;
		if (this.runtimeEnabled.has(name)) return true; // runtime re-enable wins over frontmatter
		if (this.config.skills.disabled.includes(name)) return false;
		return this.skills.get(name)?.enabled !== false;
	}

	/** Runtime toggle. Returns the new state; no-op for unknown skills. */
	setEnabled(name: string, enabled: boolean): boolean | null {
		if (!this.skills.has(name)) return null;
		this.runtimeDisabled.delete(name);
		this.runtimeEnabled.delete(name);
		if (enabled) {
			this.runtimeEnabled.add(name);
		} else {
			this.runtimeDisabled.add(name);
		}
		return this.isEnabled(name);
	}

	/** Names with a runtime override (dashboard toggles). */
	runtimeDisabledNames(): string[] {
		return [...this.runtimeDisabled];
	}

	/** Scan all configured skill directories. */
	loadAll(): { loaded: string[]; skipped: string[] } {
		const loaded: string[] = [];
		const skipped: string[] = [];
		for (const dir of this.config.skills.directories) {
			const abs = path.resolve(dir);
			if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
			for (const entry of readdirSync(abs)) {
				if (!entry.endsWith(".md")) continue;
				const name = entry.slice(0, -5);
				if (this.config.skills.disabled.includes(name)) {
					skipped.push(name);
					continue;
				}
				try {
					const skill = this.parseSkill(path.join(abs, entry));
					this.skills.set(skill.name, skill);
					loaded.push(skill.name);
				} catch (err) {
					skipped.push(name);
					console.warn(`[skills] skipped '${entry}': ${(err as Error).message}`);
				}
			}
		}
		return { loaded, skipped };
	}

	private parseSkill(filePath: string): LoadedSkill {
		const raw = readFileSync(filePath, "utf-8");
		const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
		if (!match) throw new ModuleError("skill file must start with a TOML frontmatter block (--- ... ---)");
		let meta: Record<string, unknown>;
		try {
			meta = toml.parse(match[1]) as Record<string, unknown>;
		} catch (err) {
			throw new ModuleError(`bad skill frontmatter: ${(err as Error).message}`);
		}
		const name = String(meta.name ?? path.basename(filePath, ".md"));
		if (!/^[a-z][a-z0-9_]{1,63}$/.test(name)) throw new ModuleError(`invalid skill name '${name}'`);
		const triggers = Array.isArray(meta.triggers) ? meta.triggers.map(String) : [];
		if (triggers.length === 0) throw new ModuleError(`skill '${name}' needs at least one trigger`);
		const instructions = match[2].trim();
		if (instructions.length === 0) throw new ModuleError(`skill '${name}' has no instructions body`);
		const rawExamples = Array.isArray(meta.examples) ? meta.examples : [];
		return {
			name,
			description: String(meta.description ?? ""),
			path: filePath,
			triggers,
			instructions,
			tools: Array.isArray(meta.tools) ? meta.tools.map(String) : [],
			examples: rawExamples.map((e) => {
				if (!e || typeof e !== "object") return { description: "", code: "" };
				const ex = e as Record<string, unknown>;
				return { description: String(ex.description ?? ""), code: String(ex.code ?? "") };
			}),
			priority: Number(meta.priority ?? 0) || 0,
			enabled: meta.enabled !== false,
		};
	}

	/**
	 * Find skills whose triggers match the user's message.
	 * Triggers are matched case-insensitively as substrings; wrap a trigger
	 * in slashes (like /regex/) to match it as a regular expression.
	 */
	match(message: string): SkillMatch[] {
		const text = message.toLowerCase();
		const matches: SkillMatch[] = [];
		for (const skill of this.skills.values()) {
			if (!this.isEnabled(skill.name)) continue;
			for (const trigger of skill.triggers) {
				let fired: string | null = null;
				if (trigger.startsWith("/") && trigger.endsWith("/") && trigger.length > 2) {
					try {
						if (new RegExp(trigger.slice(1, -1), "i").test(message)) fired = trigger;
					} catch { /* bad regex in config: skip it */ }
				} else if (text.includes(trigger.toLowerCase())) {
					fired = trigger;
				}
				if (fired) {
					matches.push({ skill, matched: fired });
					break; // one match per skill is enough
				}
			}
		}
		// highest priority first
		return matches.sort((a, b) => b.skill.priority - a.skill.priority);
	}

	/**
	 * Build the extra system-prompt chunk for matched skills.
	 * Caps total injection so a pile of matched skills can't blow up the prompt.
	 */
	promptFor(message: string, maxChars = 12_000): string {
		const matches = this.match(message);
		if (matches.length === 0) return "";
		const parts: string[] = [];
		let total = 0;
		for (const { skill, matched } of matches) {
			let block = `### Skill: ${skill.name}\n`;
			block += `(activated by trigger: ${matched})\n`;
			if (skill.tools.length > 0) block += `Recommended tools: ${skill.tools.join(", ")}\n`;
			for (const ex of skill.examples) {
				if (ex.description || ex.code) block += `Example: ${ex.description}\n\`\`\`tl\n${ex.code}\n\`\`\`\n`;
			}
			block += `\n${skill.instructions}\n`;
			if (total + block.length > maxChars) {
				parts.push(`(skill '${skill.name}' was skipped: prompt budget exhausted)`);
				continue;
			}
			total += block.length;
			parts.push(block);
		}
		return `You have activated the following skills. Follow their instructions.\n\n${parts.join("\n")}`;
	}

	get(name: string): LoadedSkill | undefined {
		return this.skills.get(name);
	}

	has(name: string): boolean {
		return this.skills.has(name);
	}

	names(): string[] {
		return [...this.skills.keys()];
	}

	all(): LoadedSkill[] {
		return [...this.skills.values()];
	}

	/** Loaded + enabled right now. */
	enabledAll(): LoadedSkill[] {
		return this.all().filter((s) => this.isEnabled(s.name));
	}

	count(): number {
		return this.skills.size;
	}
}
