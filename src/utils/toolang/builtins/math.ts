/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// TooLang math module

import { RuntimeError } from "../evaluator.js";

function num(v: unknown, fn: string): number {
	const n = Number(v);
	if (Number.isNaN(n)) throw new RuntimeError(`math.${fn} expects a number, got '${String(v).slice(0, 50)}'`);
	return n;
}

export function math(): Record<string, unknown> {
	return {
		PI: Math.PI,
		E: Math.E,
		rand: (min?: unknown, max?: unknown) => {
			const lo = min === undefined ? 0 : num(min, "rand");
			const hi = max === undefined ? 1 : num(max, "rand");
			if (hi < lo) throw new RuntimeError("math.rand: max must be >= min");
			return lo + Math.random() * (hi - lo);
		},
		randInt: (min: unknown, max: unknown) => {
			const lo = Math.ceil(num(min, "randInt"));
			const hi = Math.floor(num(max, "randInt"));
			if (hi < lo) throw new RuntimeError("math.randInt: max must be >= min");
			return Math.floor(Math.random() * (hi - lo + 1)) + lo;
		},
		clamp: (v: unknown, lo: unknown, hi: unknown) => Math.min(Math.max(num(v, "clamp"), num(lo, "clamp")), num(hi, "clamp")),
		max: (...vals: unknown[]) => Math.max(...vals.map((v) => num(v, "max"))),
		min: (...vals: unknown[]) => Math.min(...vals.map((v) => num(v, "min"))),
		abs: (v: unknown) => Math.abs(num(v, "abs")),
		sign: (v: unknown) => Math.sign(num(v, "sign")),
		round: (v: unknown) => Math.round(num(v, "round")),
		floor: (v: unknown) => Math.floor(num(v, "floor")),
		ceil: (v: unknown) => Math.ceil(num(v, "ceil")),
		sqrt: (v: unknown) => {
			const n = num(v, "sqrt");
			if (n < 0) throw new RuntimeError("math.sqrt of a negative number");
			return Math.sqrt(n);
		},
		pow: (v: unknown, e: unknown) => num(v, "pow") ** num(e, "pow"),
		log: (v: unknown) => {
			const n = num(v, "log");
			if (n <= 0) throw new RuntimeError("math.log requires a positive number");
			return Math.log(n);
		},
		sin: (v: unknown) => Math.sin(num(v, "sin")),
		cos: (v: unknown) => Math.cos(num(v, "cos")),
		tan: (v: unknown) => Math.tan(num(v, "tan")),
		atan2: (y: unknown, x: unknown) => Math.atan2(num(y, "atan2"), num(x, "atan2")),
	};
}
