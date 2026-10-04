// Config: snake_case keys in example.config.toml must land on the real
// settings (they used to be silently ignored), and [agent.brain] gets clamped.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadConfig, resetConfigCache, DEFAULT_CONFIG } from '../utils/config.js';

describe('config key mapping', () => {
	beforeEach(() => resetConfigCache());
	afterEach(() => resetConfigCache());

	test('snake_case keys in the example map onto the camelCase settings', () => {
		const cfg = loadConfig('example.config.toml');
		expect(cfg.http.allowedIps).toEqual(['127.0.0.1']);
		expect(cfg.skills.allowEnvAccess).toBe(false);
		expect(cfg.docker.allowedPorts).toEqual(['3456-35665']);
		expect(cfg.docker.disallowedImages).toEqual(['ftp', 'ssh', 'windows']);
		expect(cfg.docker.maxContainers).toBe(100);
		expect(cfg.agent.toolang.maxLoopIterations).toBe(10000);
		expect(cfg.agent.toolang.toolTimeoutMs).toBe(30000);
		expect(cfg.agent.toolang.http.blockPrivate).toBe(true);
		expect(cfg.agent.toolang.fs.allowWrite).toBe(true);
	});

	test('keys spelled snake_case in code keep their name', () => {
		const cfg = loadConfig('example.config.toml');
		expect(cfg.http.passcode_env).toBe('DASHBOARD_PASSCODE');
		expect(cfg.bot.guild_id).toBe('');
		// the example's VALUE is an operator choice (it ships flipped both ways):
		// what must hold is that the snake_case key survives the loader as itself
		expect(typeof cfg.agent.models.use_same_models).toBe('boolean');
	});

	test("the example's creation flags land on the real switches", () => {
		const cfg = loadConfig('example.config.toml');
		expect(cfg.agent.toolang.allowToolCreation).toBe(true);
		expect(cfg.agent.toolang.allowSkillCreation).toBe(false);
	});

	test('[general].execution_message ships with the documented default', () => {
		expect(loadConfig('example.config.toml').general.execution_message).toBe(':thinking: *Executing `[TOOL_NAME]`...*');
	});

	test('the example ships the documented brain defaults', () => {
		const cfg = loadConfig('example.config.toml');
		expect(cfg.agent.brain.memory).toBe(30);
		expect(cfg.agent.brain.reset).toBe(false);
		expect(cfg.agent.brain.likes).toEqual([]);
		expect(cfg.agent.brain.people).toEqual({});
	});
});

describe('[agent.brain] validation', () => {
	let dir: string;

	beforeEach(() => {
		resetConfigCache();
		dir = mkdtempSync(path.join(tmpdir(), 'discord-ai-cfg-'));
	});

	afterEach(() => {
		resetConfigCache();
		rmSync(dir, { recursive: true, force: true });
	});

	function loadWith(body: string) {
		const file = path.join(dir, 'config.toml');
		writeFileSync(file, body);
		resetConfigCache(); // loadConfig memoizes: each file must be read fresh
		return loadConfig(file);
	}

	test('memory is clamped to 0..200', () => {
		expect(loadWith('[agent.brain]\nmemory = 99999\n').agent.brain.memory).toBe(200);
		expect(loadWith('[agent.brain]\nmemory = -5\n').agent.brain.memory).toBe(0);
		expect(loadWith('[agent.brain]\nmemory = "lots"\n').agent.brain.memory).toBe(30);
	});

	test('taste lists accept arrays and comma strings, junk is dropped', () => {
		const cfg = loadWith('[agent.brain]\nlikes = "rust, php , ,"\ndislikes = ["crypto ads", ""]\n');
		expect(cfg.agent.brain.likes).toEqual(['rust', 'php']);
		expect(cfg.agent.brain.dislikes).toEqual(['crypto ads']);
	});

	test('reset only flips on a real boolean true', () => {
		expect(loadWith('[agent.brain]\nreset = true\n').agent.brain.reset).toBe(true);
		expect(loadWith('[agent.brain]\nreset = "yes"\n').agent.brain.reset).toBe(false);
	});

	test('capability switches only flip on a real boolean true', () => {
		// both live OUTSIDE [agent.brain] but share this loader helper on purpose:
		// they are the same class of strict-boolean switch
		expect(loadWith('[agent]\npolite_answer_when_high_user = true\n').agent.politeAnswerWhenHighUser).toBe(true);
		expect(loadWith('[agent]\npolite_answer_when_high_user = "yes"\n').agent.politeAnswerWhenHighUser).toBe(false);
		expect(loadWith('[bot]\nanswer_when_name_mention = "true"\n').bot.answer_when_name_mention).toBe(false);
	});

	test('a junk channel_id is dropped instead of matching nothing forever', () => {
		expect(loadWith('[bot]\nchannel_id = "123456789012345678"\n').bot.channel_id).toBe('123456789012345678');
		expect(loadWith('[bot]\nchannel_id = "general"\n').bot.channel_id).toBeUndefined();
	});

	test('seeded people get normalized profiles', () => {
		const cfg = loadWith(`[agent.brain.people]\n"12345" = { description = "friend", likes = "a, b" }\n`);
		expect(cfg.agent.brain.people['12345'].description).toBe('friend');
		expect(cfg.agent.brain.people['12345'].likes).toEqual(['a', 'b']);
		expect(cfg.agent.brain.people['12345'].personalities).toEqual([]);
	});

	test('a config without a brain section still boots with defaults', () => {
		const cfg = loadWith('[bot]\nstatus = "hi"\n');
		expect(cfg.agent.brain.memory).toBe(30);
		expect(cfg.agent.brain.people).toEqual({});
	});

	test('[general].execution_message stays a single capped line', () => {
		expect(loadWith('[general]\nexecution_message = "working on `[TOOL_NAME]`"\n').general.execution_message).toBe('working on `[TOOL_NAME]`');
		// a wrong type falls back to the default instead of breaking the bot
		expect(loadWith('[general]\nexecution_message = 42\n').general.execution_message).toBe(':thinking: *Executing `[TOOL_NAME]`...*');
		// control characters (newlines) are flattened: it renders into one message
		expect(loadWith('[general]\nexecution_message = "a\\nb"\n').general.execution_message).toBe('a b');
		const long = loadWith('[general]\nexecution_message = "' + 'x'.repeat(900) + '"\n').general.execution_message;
		expect(long).toHaveLength(500);
	});

	test('creation flags only flip on a real boolean true', () => {
		// these gate manage_tool / manage_skill: a stray string must not enable them
		expect(loadWith('[agent.toolang]\nallow_tool_creation = true\n').agent.toolang.allowToolCreation).toBe(true);
		expect(loadWith('[agent.toolang]\nallow_tool_creation = "yes"\n').agent.toolang.allowToolCreation).toBe(false);
		expect(loadWith('[agent.toolang]\nallow_skill_creation = 1\n').agent.toolang.allowSkillCreation).toBe(false);
		expect(loadWith('[bot]\nstatus = "x"\n').agent.toolang.allowToolCreation).toBe(false);
	});

	test('[docker] host mounts are opt-in and resolved, ports bind to loopback', () => {
		// secure by default: no mounts, loopback-only published ports
		expect(loadWith('[docker]\nenabled = true\n').docker.allowedVolumePaths).toEqual([]);
		expect(loadWith('[docker]\nenabled = true\n').docker.bindAddress).toBe('127.0.0.1');
		// resolved at load so /srv/../etc cannot slide past the prefix check later
		expect(loadWith('[docker]\nallowed_volume_paths = ["./work", "/srv/data"]\n').docker.allowedVolumePaths).toEqual([path.resolve('work'), '/srv/data']);
		expect(loadWith('[docker]\nbind_address = " 0.0.0.0 "\n').docker.bindAddress).toBe('0.0.0.0');
	});

	test('[agent] execution knobs ship with the documented defaults', () => {
		// compared against the defaults object instead of literals: tuning a
		// default must never require touching this test again
		const ex = loadConfig('example.config.toml');
		expect(ex.agent.promptFileMaxChars).toBe(DEFAULT_CONFIG.agent.promptFileMaxChars);
		expect(ex.agent.toolRounds).toBe(DEFAULT_CONFIG.agent.toolRounds);
		expect(ex.agent.toolCallsPerRound).toBe(DEFAULT_CONFIG.agent.toolCallsPerRound);
		expect(ex.agent.maxTokens).toBe(DEFAULT_CONFIG.agent.maxTokens);
	});

	test('[agent].tool_rounds clamps to 2..192, junk falls back to the default', () => {
		expect(loadWith('[agent]\ntool_rounds = 7\n').agent.toolRounds).toBe(7);
		expect(loadWith('[agent]\ntool_rounds = 999\n').agent.toolRounds).toBe(192);
		expect(loadWith('[agent]\ntool_rounds = 1\n').agent.toolRounds).toBe(2);
		expect(loadWith('[agent]\ntool_rounds = 0\n').agent.toolRounds).toBe(DEFAULT_CONFIG.agent.toolRounds);
		expect(loadWith('[agent]\ntool_rounds = "lots"\n').agent.toolRounds).toBe(DEFAULT_CONFIG.agent.toolRounds);
	});

	test('[agent].tool_calls_per_round clamps to 1..15', () => {
		expect(loadWith('[agent]\ntool_calls_per_round = 5\n').agent.toolCallsPerRound).toBe(5);
		expect(loadWith('[agent]\ntool_calls_per_round = 999\n').agent.toolCallsPerRound).toBe(15);
		expect(loadWith('[agent]\ntool_calls_per_round = 0\n').agent.toolCallsPerRound).toBe(DEFAULT_CONFIG.agent.toolCallsPerRound);
		expect(loadWith('[agent]\ntool_calls_per_round = "lots"\n').agent.toolCallsPerRound).toBe(DEFAULT_CONFIG.agent.toolCallsPerRound);
	});

	test('[agent] prompt budget is unclamped (0 = unlimited), output cap stops at 5M', () => {
		// 0 = read the whole persona file: no floor eats small files, no
		// ceiling surprises a long one, junk falls back to the default
		expect(loadWith('[agent]\nprompt_file_max_chars = 500\n').agent.promptFileMaxChars).toBe(500);
		expect(loadWith('[agent]\nprompt_file_max_chars = 0\n').agent.promptFileMaxChars).toBe(0);
		expect(loadWith('[agent]\nprompt_file_max_chars = 9999999\n').agent.promptFileMaxChars).toBe(9999999);
		expect(loadWith('[agent]\nprompt_file_max_chars = -5\n').agent.promptFileMaxChars).toBe(DEFAULT_CONFIG.agent.promptFileMaxChars);
		expect(loadWith('[agent]\nprompt_file_max_chars = "lots"\n').agent.promptFileMaxChars).toBe(DEFAULT_CONFIG.agent.promptFileMaxChars);
		expect(loadWith('[agent]\nmax_tokens = -5\n').agent.maxTokens).toBe(0);
		expect(loadWith('[agent]\nmax_tokens = 4096\n').agent.maxTokens).toBe(4096);
		expect(loadWith('[agent]\nmax_tokens = 99999999\n').agent.maxTokens).toBe(5_000_000);
		expect(loadWith('[agent]\nmax_tokens = "huge"\n').agent.maxTokens).toBe(0);
	});

	test('[general.errors] defaults ship from the example file', () => {
		const errs = loadConfig('example.config.toml').general.errors;
		expect(errs.generic).toBe('Something went wrong. The details are in the logs.');
		expect(errs.tool).toBe('tool error: {error}');
		expect(errs.external).toBe('');
		expect(errs.provider).toContain('[agent.providers]');
	});

	test('[general.errors] custom wording lands, junk falls back', () => {
		const cfg = loadWith('[general.errors]\ntool = "boom: {error}"\nexternal = "{service} is down"\n');
		expect(cfg.general.errors.tool).toBe('boom: {error}');
		expect(cfg.general.errors.external).toBe('{service} is down');
		expect(cfg.general.errors.generic).toBe('Something went wrong. The details are in the logs.');
		// wrong type -> default instead of breaking the bot
		expect(loadWith('[general.errors]\ngeneric = 42\n').general.errors.generic).toBe('Something went wrong. The details are in the logs.');
		// an empty generic would post an empty error reply: refused
		expect(loadWith('[general.errors]\ngeneric = ""\n').general.errors.generic).toBe('Something went wrong. The details are in the logs.');
		// external empty IS meaningful ("use generic") and allowed
		expect(loadWith('[general.errors]\nexternal = ""\n').general.errors.external).toBe('');
		// control characters flattened, over-long capped at 500
		expect(loadWith('[general.errors]\ntool = "a\\nb"\n').general.errors.tool).toBe('a b');
		expect(loadWith('[general.errors]\nprovider = "' + 'y'.repeat(900) + '"\n').general.errors.provider).toHaveLength(500);
		// a broken [general] section still boots with every default intact
		const broken = loadWith('general = 5\n');
		expect(broken.general.errors.tool).toBe('tool error: {error}');
		expect(broken.general.execution_message).toBe(':thinking: *Executing `[TOOL_NAME]`...*');
	});
});
