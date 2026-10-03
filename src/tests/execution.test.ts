// The "Executing ..." progress message: one message per tool-using turn, sent
// on the first round, edited on every following one, deleted before the final
// reply. It must never ping anyone and never break the actual answer.

import { describe, test, expect } from 'bun:test';
import { ExecutionStatus, renderExecutionMessage, ExecMessageLike } from '../execution.js';

const TEMPLATE = ':thinking: *Executing `[TOOL_NAME]`...*';

function makeChannel(opts: { failSend?: boolean } = {}) {
	const sent: { content: string; allowedMentions: { parse: string[] } }[] = [];
	const edits: string[] = [];
	let deleted = 0;
	const msg: ExecMessageLike = {
		edit: async (content: string) => {
			edits.push(content);
		},
		delete: async () => {
			deleted++;
		}
	};
	const channel = {
		send: async (payload: { content: string; allowedMentions: { parse: string[] } }) => {
			if (opts.failSend) throw new Error('Missing Permissions');
			sent.push(payload);
			return msg;
		}
	};
	return { channel, sent, edits, deleted: () => deleted };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe('renderExecutionMessage', () => {
	test('replaces every placeholder with the plain tool names (the template formats them)', () => {
		expect(renderExecutionMessage(TEMPLATE, ['docker_list'])).toBe(':thinking: *Executing `docker_list`...*');
		expect(renderExecutionMessage('call [TOOL_NAME] then [TOOL_NAME]', ['a'])).toBe('call a then a');
		expect(renderExecutionMessage(TEMPLATE, ['a', 'b'])).toBe(':thinking: *Executing `a, b`...*');
		expect(renderExecutionMessage(TEMPLATE, [])).toBe(':thinking: *Executing `(unknown)`...*');
	});

	test("stays inside Discord's 2000 char limit", () => {
		expect(renderExecutionMessage('x[TOOL_NAME]', ['y'.repeat(3_000)]).length).toBeLessThanOrEqual(2_000);
	});
});

describe('ExecutionStatus', () => {
	test('first round sends, next rounds edit the SAME message, end deletes it', async () => {
		const { channel, sent, edits, deleted } = makeChannel();
		const exec = new ExecutionStatus(channel, TEMPLATE);

		exec.update(['first_tool']);
		await settle();
		expect(sent).toHaveLength(1);
		expect(sent[0].content).toBe(':thinking: *Executing `first_tool`...*');
		expect(sent[0].allowedMentions.parse).toEqual([]); // never pings

		exec.update(['second_tool']);
		exec.update(['third_tool']);
		await settle();
		expect(sent).toHaveLength(1); // never a second message
		expect(edits).toEqual([':thinking: *Executing `second_tool`...*', ':thinking: *Executing `third_tool`...*']);

		await exec.end();
		expect(deleted()).toBe(1);
	});

	test('an empty template disables it completely', async () => {
		const { channel, sent, deleted } = makeChannel();
		const exec = new ExecutionStatus(channel, '');
		expect(exec.enabled).toBe(false);
		exec.update(['anything']);
		await settle();
		expect(sent).toHaveLength(0);
		await exec.end();
		expect(deleted()).toBe(0);
	});

	test('nothing is sent when the model never calls a tool, and end() is safe to await', async () => {
		const { channel, sent, deleted } = makeChannel();
		const exec = new ExecutionStatus(channel, TEMPLATE);
		await exec.end();
		expect(sent).toHaveLength(0);
		expect(deleted()).toBe(0);
	});

	test('updates after end() are dropped instead of resurrecting the message', async () => {
		const { channel, sent, edits, deleted } = makeChannel();
		const exec = new ExecutionStatus(channel, TEMPLATE);
		exec.update(['a_tool']);
		await settle();
		await exec.end();
		exec.update(['z_tool']);
		await settle();
		expect(sent).toHaveLength(1);
		expect(edits).toHaveLength(0);
		expect(deleted()).toBe(1);
	});

	test('a send/edit failure is reported but never throws into the chat', async () => {
		const errors: string[] = [];
		const failing = makeChannel({ failSend: true });
		const exec = new ExecutionStatus(failing.channel, TEMPLATE, (m) => errors.push(m));
		exec.update(['a_tool']);
		await settle();
		expect(errors.join(' ')).toContain('Missing Permissions');
		await expect(exec.end()).resolves.toBeUndefined();
	});
});
