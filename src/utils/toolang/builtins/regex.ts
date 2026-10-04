/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// TooLang regex module.
// Patterns come from the model, so this is a ReDoS-sensitive surface: length
// caps on both sides, an allowlist of flags, a match counter, and a scanner
// that refuses the classic nested-backtracking shapes ((a+)+, (a|aa)+, ...).
// JS regex cannot be interrupted mid-match, so refusing the pattern is the
// only real defense.

import { RuntimeError } from '../evaluator.js';

/** longest pattern / subject we will compile or scan */
const PATTERN_CAP = 300;
const TEXT_CAP = 50_000;
/** hard stop for matchAll/replace loops */
const MATCH_CAP = 1_000;
/** only these flags exist on every engine we care about */
const FLAGS = 'dgimsuy';

/**
 * Refuse patterns whose quantified group contains its own quantifier or an
 * alternation: those are the shapes that backtrack exponentially
 * ((a+)+, (a*)*, (a|aa)+, (\d+){2,}). Plain top-level quantifiers
 * (a+, \d{1,3}) and unquantified groups pass.
 */
function looksDangerous(pattern: string): boolean {
	let depth = 0;
	let bodyStart = -1;
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === '\\') {
			i++; // escaped char, never a paren or quantifier
			continue;
		}
		if (ch === '(') {
			if (depth === 0) bodyStart = i;
			depth++;
			continue;
		}
		if (ch === ')') {
			depth--;
			if (depth === 0 && bodyStart >= 0) {
				const body = pattern.slice(bodyStart + 1, i);
				const next = pattern[i + 1];
				if (next === '*' || next === '+' || next === '{') {
					if (/[|+*{}]/.test(body)) return true;
				}
			}
			continue;
		}
	}
	return false;
}

/** compile with guards; every entry point funnels through here */
function compile(pattern: unknown, flags: unknown, op: string): RegExp {
	const p = String(pattern ?? '');
	if (p.length === 0 || p.length > PATTERN_CAP) throw new RuntimeError(`regex.${op}: pattern must be 1..${PATTERN_CAP} chars`);
	const f = String(flags ?? '');
	for (const c of f) if (!FLAGS.includes(c)) throw new RuntimeError(`regex.${op}: unknown flag '${c}' (allowed: ${FLAGS.split('').join('')})`);
	if (looksDangerous(p)) throw new RuntimeError(`regex.${op}: pattern backtracks exponentially (a quantified group holds a quantifier or alternation): rewrite it`);
	try {
		return new RegExp(p, f);
	} catch (err) {
		throw new RuntimeError(`regex.${op}: invalid pattern: ${(err as Error).message}`);
	}
}

/** the subject text, capped so one call cannot feed a monster to the engine */
function subject(text: unknown, op: string): string {
	const t = String(text ?? '');
	if (t.length > TEXT_CAP) throw new RuntimeError(`regex.${op}: text too long (${t.length} > ${TEXT_CAP} chars)`);
	return t;
}

interface Hit {
	match: string;
	index: number;
	groups: (string | null)[];
}

function toHit(m: RegExpExecArray): Hit {
	return { match: m[0], index: m.index, groups: Array.from(m.slice(1), (g) => (g === undefined ? null : g)) };
}

export function regex(): Record<string, unknown> {
	return {
		/** does the pattern match? (first hit only, no /g needed) */
		test: (pattern: unknown, text: unknown, flags?: unknown) => compile(pattern, flags, 'test').test(subject(text, 'test')),
		/** first hit: { match, index, groups } or null */
		match: (pattern: unknown, text: unknown, flags?: unknown) => {
			const re = compile(pattern, flags, 'match');
			const m = re.exec(subject(text, 'match'));
			return m ? toHit(m) : null;
		},
		/** every hit as { match, index, groups }, capped at MATCH_CAP */
		matchAll: (pattern: unknown, text: unknown, flags?: unknown) => {
			// /g is implied: without it matchAll would loop forever on exec
			const raw = String(flags ?? '');
			const re = compile(pattern, raw.includes('g') ? raw : raw + 'g', 'matchAll');
			const t = subject(text, 'matchAll');
			const out: Hit[] = [];
			let m: RegExpExecArray | null;
			while ((m = re.exec(t)) !== null) {
				out.push(toHit(m));
				if (m[0] === '') re.lastIndex++; // empty match: keep moving
				if (out.length >= MATCH_CAP) break;
			}
			return out;
		},
		/** replace all matches ($1..$9 group refs work natively; no code runs) */
		replace: (pattern: unknown, text: unknown, replacement: unknown, flags?: unknown) => {
			const raw = String(flags ?? '');
			// /g is implied: replacing ONE occurrence surprises everyone
			const re = compile(pattern, raw.includes('g') ? raw : raw + 'g', 'replace');
			return subject(text, 'replace').replace(re, String(replacement ?? ''));
		}
	};
}
