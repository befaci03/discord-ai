// Renders the "### Tools you can call right now" system-prompt block.
// Split out of brain.ts so the prompt format stays testable on its own.
//
// Two things matter here: the model must see TYPED signatures (a bare
// `name(a, b)` gives no clue which arg is a string or optional), and it must
// be told to call tools instead of narrating what it would do.

import type { Tool } from './struct.js';

/** Short type labels that keep one tool on a single readable line. */
const TYPE_LABEL: Record<string, string> = {
	string: 'str',
	number: 'num',
	boolean: 'bool',
	array: 'arr',
	object: 'obj'
};

/** `count_lines(path: str, grep: str?): count lines in a file` */
function signature(t: Tool): string {
	const props = (t.parameters?.properties ?? {}) as Record<string, Record<string, unknown>>;
	const rawRequired = t.parameters?.required;
	const required = Array.isArray(rawRequired) ? rawRequired.map(String) : [];
	const names = Object.keys(props);
	if (names.length === 0) return `${t.name}()`;
	const args = names.map((n) => {
		const type = TYPE_LABEL[String(props[n]?.type ?? '')] ?? 'any';
		return `${n}: ${type}${required.includes(n) ? '' : ' (optional)'}`;
	});
	return `${t.name}(${args.join(', ')})`;
}

/** How many tools get a line before the block starts hiding the rest. */
const MAX_LINES = 60;
const MAX_DESC = 160;

/**
 * Build the tool inventory block. Rebuilt on every ask, so runtime toggles
 * show up immediately: a tool toggled off disappears from this list AND from
 * the schema sent to the provider.
 */
export function renderToolsBlock(callable: Tool[]): string {
	if (callable.length === 0) {
		return '\n### Tools\nYou have no tools available right now: answer from your own knowledge and say when you are unsure.\n';
	}
	const list = callable.slice(0, MAX_LINES);
	const lines = list.map((t) => {
		const desc = t.description.replace(/\s+/g, ' ').trim().slice(0, MAX_DESC);
		return `- ${signature(t)}: ${desc}`;
	});
	const hidden = callable.length - list.length;
	const more = hidden > 0 ? `\n(+${hidden} more callable, not listed here)` : '';
	return (
		'\n### Tools you can call right now\n' +
		'When a tool fits the request, CALL it through the tool-calling interface: never describe what you would do instead, never write a call (tool name plus arguments) as plain text in your reply, never hand-write code for something a tool already does, and never invent a tool that is not listed here. ' +
		'A call typed out as text is not a call: the work simply did not happen. ' +
		'If a tool comes back with an error, fix the arguments and call it again (or take another path) instead of giving up, and never report a result for a tool you have not actually called in this turn. ' +
		'If nothing fits, answer normally.\n' +
		lines.join('\n') +
		more +
		'\n'
	);
}
