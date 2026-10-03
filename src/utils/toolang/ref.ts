	/// Befaci @ Mozilla Public License V2.0
	/// Please see the LICENSE file for more information.

	import { ToolDef } from "../llmproto/types.js";

	export const BUILTIN_MODULES = {
		http: {
			get: "http.get(url: string) -> { status, response, headers }",
			post: "http.post(url, body?) -> { status, response, headers }",
			put: "http.put(url, body?) -> { status, response, headers }",
			patch: "http.patch(url, body?) -> { status, response, headers }",
			delete: "http.delete(url) -> { status, response, headers }",
			head: "http.head(url) -> { status, response, headers }",
			options: "http.options(url) -> { status, response, headers }",
		},
		json: {
			to: "json.to(text: string) -> object (parse JSON)",
			from: "json.from(obj: object) -> string (stringify JSON)",
		},
		math: {
			rand: "math.rand(min?, max?) -> number",
			randInt: "math.randInt(min, max) -> integer",
			clamp: "math.clamp(v, lo, hi) -> number",
			max: "math.max(...nums) -> number",
			min: "math.min(...nums) -> number",
			abs: "math.abs(n) -> number",
			round: "math.round(n) -> number",
			floor: "math.floor(n) -> number",
			ceil: "math.ceil(n) -> number",
			sqrt: "math.sqrt(n) -> number",
			pow: "math.pow(base, exp) -> number",
			log: "math.log(n) -> number",
			sin: "math.sin(n) -> number",
			cos: "math.cos(n) -> number",
			tan: "math.tan(n) -> number",
			atan2: "math.atan2(y, x) -> number",
			PI: "math.PI -> 3.14159...",
			E: "math.E -> 2.71828...",
		},
		time: {
			now: "time.now() -> epoch ms",
			timestamp: "time.timestamp() -> epoch seconds",
			iso: "time.iso() -> ISO string",
			fromIso: "time.fromIso(str) -> epoch ms",
			toIso: "time.toIso(ms) -> ISO string",
			year: "time.year(ms?) -> number (utc)",
			month: "time.month(ms?) -> 1-12 (utc)",
			day: "time.day(ms?) -> number (utc)",
			hour: "time.hour(ms?) -> number (utc)",
			minute: "time.minute(ms?) -> number",
			second: "time.second(ms?) -> number",
			weekday: "time.weekday(ms?) -> 0-6 (sunday first)",
			humanize: "time.humanize(seconds) -> '1h 02m 03s'",
			uptime: "time.uptime() -> process uptime seconds",
		},
		codec: {
			base64Encode: "codec.base64Encode(text) -> string",
			base64Decode: "codec.base64Decode(text) -> string",
			hexEncode: "codec.hexEncode(text) -> string",
			hexDecode: "codec.hexDecode(hex) -> string",
			urlEncode: "codec.urlEncode(text) -> string",
			urlDecode: "codec.urlDecode(text) -> string",
			hash: "codec.hash(algo, text) -> hex digest (sha1/sha256/sha384/sha512/md5)",
			randomToken: "codec.randomToken(bytes?) -> secure random base64url token",
			uuid: "codec.uuid() -> uuid v4 string",
		},
		fs: {
			read: "fs.read(path) -> string (sandboxed)",
			write: "fs.write(path, content) -> true (create only, if allowed)",
			append: "fs.append(path, content) -> true (if allowed)",
			list: "fs.list(path) -> array of names",
			mkdir: "fs.mkdir(path) -> true",
			remove: "fs.remove(path) -> true (empty dirs/files)",
			rmtree: "fs.rmtree(path) -> true (recursive, if allowed)",
			exists: "fs.exists(path) -> boolean",
			isDir: "fs.isDir(path) -> boolean",
			size: "fs.size(path) -> bytes",
		},
		log: {
			info: "log.info(...args)",
			warn: "log.warn(...args)",
			error: "log.error(...args)",
			debug: "log.debug(...args) (only when DEBUG=1)",
		},
		node: {
			child_proc: { run: "node.child_proc.run(cmd) -> { stdout, stderr, exitCode } (guarded)" },
			child_process: { run: "alias of node.child_proc.run" },
			bcrypt: {
				hash: "node.bcrypt.hash(password, rounds?) -> hash",
				compare: "node.bcrypt.compare(password, hash) -> boolean",
				generateSalt: "node.bcrypt.generateSalt(rounds?) -> salt",
			},
		},
		Array: {
			slice: "Array.slice(arr, start, end?) -> array",
			push: "Array.push(arr, item) -> array",
			length: "Array.length(arr) -> number",
			range: "Array.range(start, end?, step?) -> number[]",
			repeat: "Array.repeat(item, count) -> array",
		},
		Object: {
			keys: "Object.keys(obj) -> string[]",
			values: "Object.values(obj) -> array",
			entries: "Object.entries(obj) -> [key, value][]",
			fromEntries: "Object.fromEntries(pairs) -> object",
			merge: "Object.merge(a, b) -> object",
			freeze: "Object.freeze(obj) -> object",
		},
	} as const;

	export const KEYWORDS = [
		"set", "var", "to", "fn", "with", "do", "close", "return", "call",
		"while", "for", "in", "if", "elif", "then", "else",
		"break", "continue", "try", "catch", "throw",
		"true", "false", "null", "and", "or", "not",
	] as const;

	export const OPERATORS = [
		"+", "-", "*", "/", "%", "**", "==", "!=", "<", "<=", ">", ">=",
		"&&", "||", "!", "=", "+=", "-=", "*=", "/=", "%=",
	] as const;

	export const SYNTAX = {
		toolHeader: `{ "name": "...", "description": "...", "arguments": [...] }¤`,
		comment: "--= this is a comment",
		variable: "set var <name> to <expr>",
		assignment: "<name> = <expr>  |  x += 1",
		function: "fn <name> with (<param>: <type>) do ... close",
		returnStmt: "return <expr>",
		callBuiltin: "http.get(url)",
		callFn: "call(<fn_name>, <arg1>, <arg2>)",
		ifStmt: "if <cond> then ... elif <cond> then ... else ... close",
		whileLoop: "while <cond> do ... close",
		forLoop: "for <var> in <iterable> do ... close",
		tryCatch: "try do ... catch e do ... close",
		throwStmt: "throw(<message>)",
		stringInterp: '"x is ${x}" or "hello {0}".format([name])',
		memberAccess: "obj.property",
		indexAccess: "arr[0]",
		templateString: '"total: ${a.b + 1}"',
	} as const;

	export function validateArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
		const errors: string[] = [];

		for (const argDef of tool.arguments) {
			const val = args[argDef.name];

			// check required
			if (val === undefined || val === null) {
				errors.push(`Missing required argument: ${argDef.name}`);
				continue;
			}

			switch (argDef.type) {
				case "string":
					if (typeof val !== "string") {
						errors.push(`Argument '${argDef.name}' must be a string, got ${typeof val}`);
					}
					break;
				case "number":
					if (typeof val !== "number") {
						errors.push(`Argument '${argDef.name}' must be a number, got ${typeof val}`);
					}
					break;
				case "boolean":
					if (typeof val !== "boolean") {
						errors.push(`Argument '${argDef.name}' must be a boolean, got ${typeof val}`);
					}
					break;
			}

			// check disallow
			if (typeof val === "string" && argDef.disallow.length > 0) {
				if (argDef.disallow.includes(val)) {
					errors.push(`Argument '${argDef.name}' disallows value: '${val}'`);
				}
			}
		}

		return errors;
	}
