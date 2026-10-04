/**
 * Fake tool calls are text the model typed instead of calling a tool: either
 * private-use-tag markup lines (a U+E200-style delimiter plus the tool name,
 * then <arg_key>/<arg_value> lines) or a bare `toolname key: value` line.
 * Matched line by line: all the observed markup sits on its own lines, so
 * stripping is predictable and legitimate prose survives.
 * Exported for tests.
 */
interface FakeCall {
	start: number;
	end: number;
	name: string;
}

/** private-use chars models emit as fake-call tag delimiters (U+E000..U+F8FF) */
const PUA_CHAR = /[\uE000-\uF8FF]/;
/** a fake-call opening tag: delimiter + tool name */
const PUA_NAME = /[\uE000-\uF8FF][ \t]*\/?([a-z][a-z0-9_]{1,63})/;
/** `<arg_key>container</arg_key>` style lines */
const ARG_TAG_LINE = /^[^\n]*<\/?arg_[A-Za-z0-9_]+>[^\n]*$/;
/** `toolname key: value key: value` (at least one ` key:` after the name) */
const TYPED_LINE = /^([a-z][a-z0-9_]{1,63})((?:[ \t]+\w+:[^\n]*)+)$/;

function findFakeCalls(text: string, isKnownTool?: (name: string) => boolean): FakeCall[] {
	const out: FakeCall[] = [];
	let offset = 0;
	for (const line of text.split('\n')) {
		const start = offset;
		offset += line.length + 1;
		let name = '';
		if (PUA_CHAR.test(line) || ARG_TAG_LINE.test(line)) {
			const m = PUA_NAME.exec(line);
			name = m ? m[1] : '<arg markup>';
		} else {
			const m = TYPED_LINE.exec(line.trim());
			// three or more `key:` pairs already look like a typed call; fewer
			// only count when the name is a real tool ("next steps: ..." lives)
			if (m && ((m[0].match(/\w+:/g) ?? []).length >= 3 || (isKnownTool !== undefined && isKnownTool(m[1])))) name = m[1];
		}
		if (name) out.push({ start, end: start + line.length, name });
	}
	return out;
}

/** Names of fake tool calls found in `text` (unique, capped). */
export function detectFakeToolCalls(text: string, isKnownTool?: (name: string) => boolean): string[] {
	const found: string[] = [];
	for (const c of findFakeCalls(text, isKnownTool)) if (!found.includes(c.name)) found.push(c.name);
	return found.slice(0, 25);
}

/** Remove fake tool call lines from a reply before it is sent. */
export function stripFakeToolCalls(text: string, isKnownTool?: (name: string) => boolean): string {
	const calls = findFakeCalls(text, isKnownTool);
	if (calls.length === 0) return text;
	let out = '';
	let last = 0;
	for (const c of calls) {
		out += text.slice(last, c.start);
		last = c.end + (text[c.end] === '\n' ? 1 : 0); // take the line's newline too
	}
	return (out + text.slice(last)).replace(/\n{3,}/g, '\n\n').trim();
}
