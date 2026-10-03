/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// TooLang built-in method dispatch for primitive types

import { RuntimeError } from "./evaluator.js";
import { InterpreterLimits, resolveLimits } from "./limits.js";

const limits: InterpreterLimits = resolveLimits();

function assertStr(v: unknown, method: string, argIdx: number): string {
	if (typeof v !== "string") throw new RuntimeError(`string.${method}() argument ${argIdx} must be a string`);
	return v;
}

export function stringMethod(str: string, method: string, args: unknown[]): unknown {
	switch (method) {
		case "replace": return str.replace(assertStr(args[0], method, 0), String(args[1] ?? ""));
		case "replaceAll": return str.replaceAll(assertStr(args[0], method, 0), String(args[1] ?? ""));
		case "substr": {
			const start = Number(args[0] ?? 0);
			const len = args[1] != null ? Number(args[1]) : undefined;
			return str.slice(start, len);
		}
		case "toUpperCase": return str.toUpperCase();
		case "toLowerCase": return str.toLowerCase();
		case "trim": return str.trim();
		case "toNumber": return Number(str);
		case "toBoolean": return str.toLowerCase() === "true" || str === "1";
		case "format":
			// placeholders are 1-based to match the language convention: "a {1} b {2}".format([x, y])
			const arr = Array.isArray(args[0]) ? args[0] : [];
			return str.replace(/\{(\d+)\}/g, (_, idx) => {
				const i = Number(idx) - 1;
				return i >= 0 && i < arr.length ? String(arr[i]) : `{${idx}}`;
			});
		case "split": return str.split(String(args[0] ?? ""));
		case "includes": return str.includes(String(args[0] ?? ""));
		case "startsWith": return str.startsWith(String(args[0] ?? ""));
		case "endsWith": return str.endsWith(String(args[0] ?? ""));
		case "indexOf": return str.indexOf(String(args[0] ?? ""));
		case "lastIndexOf": return str.lastIndexOf(String(args[0] ?? ""));
		case "length": return str.length;
		case "repeat": {
			const n = Number(args[0] ?? 0);
			if (n < 0 || n * str.length > limits.maxOutputLength) throw new RuntimeError("repeat would produce an oversized string");
			return str.repeat(n);
		}
		case "padStart": return str.padStart(Number(args[0] ?? 0), String(args[1] ?? " "));
		case "padEnd": return str.padEnd(Number(args[0] ?? 0), String(args[1] ?? " "));
		case "chars": return str.split("");
		case "reverse": return str.split("").reverse().join("");
		case "codePointAt": return str.codePointAt(Number(args[0] ?? 0));
		case "isNumeric": return str.trim() !== "" && !Number.isNaN(Number(str));
		case "isEmpty": return str.length === 0;
		case "toJson": return JSON.stringify(str);
		default: throw new RuntimeError(`string has no method '${method}'`);
	}
}

export function numberMethod(num: number, method: string, args: unknown[]): unknown {
	switch (method) {
		case "toString": return String(num);
		case "toFixed": return num.toFixed(Number(args[0] ?? 0));
		case "toBoolean": return num !== 0;
		case "abs": return Math.abs(num);
		case "round": return Math.round(num);
		case "floor": return Math.floor(num);
		case "ceil": return Math.ceil(num);
		case "sqrt": return Math.sqrt(num);
		case "pow": return num ** Number(args[0] ?? 1);
		case "clamp": {
			const lo = Number(args[0] ?? 0);
			const hi = Number(args[1] ?? 1);
			return Math.min(Math.max(num, lo), hi);
		}
		case "isInteger": return Number.isInteger(num);
		case "isNegative": return num < 0;
		case "isNan": return Number.isNaN(num);
		case "toStringRadix": return num.toString(Number(args[0] ?? 10));
		default: throw new RuntimeError(`number has no method '${method}'`);
	}
}

export function arrayMethod(arr: unknown[], method: string, args: unknown[]): unknown {
	switch (method) {
		case "push": {
			const copy = [...arr];
			copy.push(args[0]);
			return copy;
		}
		case "pop": {
			const copy = [...arr];
			copy.pop();
			return copy;
		}
		case "shift": {
			const copy = [...arr];
			copy.shift();
			return copy;
		}
		case "unshift": {
			const copy = [...arr];
			copy.unshift(args[0]);
			return copy;
		}
		case "reverse": return [...arr].reverse();
		case "join": return arr.map(String).join(String(args[0] ?? ""));
		case "slice": return arr.slice(Number(args[0] ?? 0), args[1] != null ? Number(args[1]) : undefined);
		case "length": return arr.length;
		case "concat": {
			const other = args[0];
			if (!Array.isArray(other)) throw new RuntimeError("array.concat expects an array");
			return [...arr, ...other];
		}
		case "indexOf": return arr.indexOf(args[0]);
		case "includes": return arr.includes(args[0]);
		case "first": return arr.length > 0 ? arr[0] : null;
		case "last": return arr.length > 0 ? arr[arr.length - 1] : null;
		case "unique": return [...new Set(arr)];
		case "flat": {
			const depth = Number(args[0] ?? 1);
			return arr.flat(depth);
		}
		case "sum": return arr.reduce((acc: number, v) => acc + Number(v), 0);
		case "min": return arr.length === 0 ? null : Math.min(...arr.map(Number));
		case "max": return arr.length === 0 ? null : Math.max(...arr.map(Number));
		case "isEmpty": return arr.length === 0;
		case "toJson": return JSON.stringify(arr);
		default: throw new RuntimeError(`array has no method '${method}'`);
	}
}

export function objectMethod(obj: Record<string, unknown>, method: string, args: unknown[]): unknown {
	switch (method) {
		case "keys": return Object.keys(obj);
		case "values": return Object.values(obj);
		case "entries": return Object.entries(obj);
		case "has": return String(args[0] ?? "") in obj;
		case "length": return Object.keys(obj).length;
		case "isEmpty": return Object.keys(obj).length === 0;
		case "remove": {
			const copy = { ...obj };
			delete copy[String(args[0] ?? "")];
			return copy;
		}
		case "merge": {
			const other = args[0];
			if (!other || typeof other !== "object" || Array.isArray(other)) throw new RuntimeError("object.merge expects an object");
			return { ...obj, ...(other as Record<string, unknown>) };
		}
		case "toJson": return JSON.stringify(obj);
		default: throw new RuntimeError(`object has no method '${method}'`);
	}
}
