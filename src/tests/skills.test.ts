// The skill directory the model gets in its system prompt: without it the
// model only ever sees a skill's instructions once a trigger fired, and has no
// idea the skill exists at all.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { loadConfig, resetConfigCache } from '../utils/config.js';
import { SkillRegistry, parseSkillSource } from '../modules/skills.js';

describe('skill overview', () => {
	beforeEach(() => resetConfigCache());
	afterEach(() => resetConfigCache());

	test('lists enabled skills with their keywords', () => {
		const skills = new SkillRegistry(loadConfig('example.config.toml'));
		const stats = skills.loadAll();
		expect(stats.loaded).toContain('toolang');

		const overview = skills.overview();
		expect(overview).toContain('toolang');
		expect(overview).toContain('keywords:');
		// bounded: a pile of skills must not eat the prompt
		expect(overview.length).toBeLessThan(2_000);
	});

	test('a disabled skill disappears from the directory', () => {
		const skills = new SkillRegistry(loadConfig('example.config.toml'));
		skills.loadAll();
		skills.setEnabled('toolang', false);
		expect(skills.overview()).toBe('');
	});

	test('an empty registry produces no block at all', () => {
		const skills = new SkillRegistry(loadConfig('example.config.toml'));
		expect(skills.overview()).toBe('');
	});
});

describe('trigger bounds', () => {
	function source(triggers: string): string {
		return `---\nname = "bulk"\ntriggers = [${triggers}]\n---\n\ndo the thing.\n`;
	}

	test('the trigger list is capped: they run against every message', () => {
		const many = Array.from({ length: 30 }, (_, i) => `"t${i}"`).join(', ');
		const skill = parseSkillSource(source(many), 'bulk.md');
		expect(skill.triggers).toHaveLength(20);
	});

	test('one trigger is capped and blank ones are dropped', () => {
		const skill = parseSkillSource(source(`"${'x'.repeat(500)}", "  ", "real"`), 'bulk.md');
		expect(skill.triggers[0]).toHaveLength(120);
		expect(skill.triggers).toEqual([skill.triggers[0], 'real']);
	});

	test('a regex trigger can never grow past the engine guard', () => {
		const skill = parseSkillSource(source(`"/${'a?'.repeat(200)}/"`), 'bulk.md');
		// match() skips regex triggers longer than 122 chars entirely
		expect(skill.triggers[0].length).toBeLessThanOrEqual(120);
	});
});
