// Error wording: user-safe messages pass through, operator templates replace
// the generic texts, and internal causes never reach chat through them.

import { describe, test, expect } from 'bun:test';
import { UserError, ValidationError, ExternalError, toUserMessage, toToolMessage, noProviderMessage, DEFAULT_ERROR_TEMPLATES } from '../utils/errors.js';

describe('toUserMessage', () => {
	test('user errors pass through, capped at the Discord limit', () => {
		expect(toUserMessage(new ValidationError('port must be a number'))).toBe('port must be a number');
		expect(toUserMessage(new UserError('x'.repeat(4000)))).toHaveLength(2000);
	});

	test('unexpected errors render the generic template, never the cause', () => {
		const boom = new Error('secret sk-test-123 blew up at src/index.ts:42');
		const shown = toUserMessage(boom);
		expect(shown).toBe(DEFAULT_ERROR_TEMPLATES.generic);
		expect(shown).not.toContain('sk-test-123');
		expect(shown).not.toContain('src/index.ts');
	});

	test('external errors show only the service name when a template is set', () => {
		const err = new ExternalError('openai', new Error('api key revoked'));
		// no template configured: generic text, exactly like before
		expect(toUserMessage(err)).toBe(DEFAULT_ERROR_TEMPLATES.generic);
		const shown = toUserMessage(err, { external: '{service} is unreachable, try again.' });
		expect(shown).toBe('openai is unreachable, try again.');
		expect(shown).not.toContain('revoked');
	});

	test('a custom generic template wins, empty falls back to the default', () => {
		expect(toUserMessage(new Error('x'), { generic: 'try again later' })).toBe('try again later');
		expect(toUserMessage(new Error('x'), { generic: '' })).toBe(DEFAULT_ERROR_TEMPLATES.generic);
	});
});

describe('toToolMessage', () => {
	test('{error} carries the user-safe inner message', () => {
		expect(toToolMessage(new ValidationError('container name is invalid'))).toBe('tool error: container name is invalid');
	});

	test('unexpected failures use the generic text inside the tool template', () => {
		expect(toToolMessage(new Error('boom'))).toBe('tool error: Something went wrong. The details are in the logs.');
	});

	test('a custom template renders only its placeholder', () => {
		const shown = toToolMessage(new ValidationError('no such container'), { tool: 'docker failed while {error}' });
		expect(shown).toBe('docker failed while no such container');
	});

	test('the rendered message stays under the Discord limit', () => {
		expect(toToolMessage(new UserError('y'.repeat(4000)))).toHaveLength(2000);
	});
});

describe('noProviderMessage', () => {
	test('default text names the config keys', () => {
		expect(noProviderMessage()).toContain('[agent.providers]');
		expect(noProviderMessage()).toContain('[agent.models]');
	});

	test('custom wording wins, junk falls back', () => {
		expect(noProviderMessage({ provider: 'no model configured' })).toBe('no model configured');
		expect(noProviderMessage({ provider: '' })).toContain('[agent.providers]');
	});
});
