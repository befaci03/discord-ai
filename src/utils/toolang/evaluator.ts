/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// Read README.md cuz i'm lazy to write quick summary

import type { Client as DiscordClient } from 'discord.js';
import type Agent from '../../agent/struct.js';
import { Program, Statement, Expr, FnDef } from './ast.js';
import { Docker as dockerModule } from './builtins/docker.js';
import { Discord as discordModule } from './builtins/discord.js';
import { Agent as agentModule } from './builtins/agent.js';
import { HTTP as httpModule, json as jsonModule, array as arrayModule, object as objectModule } from './builtins/std.js';
import { NodeJS as nodejsModule } from './builtins/node.js';
import { math as mathModule } from './builtins/math.js';
import { time as timeModule } from './builtins/time.js';
import { codec as codecModule } from './builtins/codec.js';
import { regex as regexModule } from './builtins/regex.js';
import { fs as fsModule } from './builtins/fs.js';
import { log as logModule } from './builtins/log.js';
import { sys as sysModule } from './builtins/sys.js';
import { env as envModule } from './builtins/env.js';
import { stringMethod, numberMethod, arrayMethod, objectMethod } from './methods.js';
import { InterpreterLimits } from './limits.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';

export class RuntimeError extends Error {
	constructor(message: string) {
		super(`Runtime error: ${message}`);
		this.name = 'RuntimeError';
	}
}

export class TooLangError extends Error {
	constructor(message: string) {
		super(`TooLang error: ${message}`);
		this.name = 'TooLangError';
	}
}

export interface InterpreterContext {
	discord?: DiscordClient;
	agent?: Agent;
	configPath?: string;
	/** ToolangConfig from src/utils/config.ts, sandbox/fs and other toggles live here */
	config?: Record<string, unknown>;
	/** Extra values exposed as top-level TooLang variables (e.g. addons) */
	extraVars?: Record<string, unknown>;
	/** when true, the gated `env` module is enabled (skills.allow_env_access) */
	envAccess?: boolean;
	limits?: Partial<InterpreterLimits>;
}

const DEFAULT_LIMITS: InterpreterLimits = {
	maxLoopIterations: 10_000,
	maxCallDepth: 64,
	maxSteps: 200_000,
	maxOutputLength: 100_000
};

export class Evaluator {
	private vars = new Map<string, unknown>();
	private fns = new Map<string, FnDef>();
	private limits: InterpreterLimits;
	private steps = 0;
	private callDepth = 0;
	private loopDepth = 0;

	private static RETURN = Symbol('RETURN');
	private static BREAK = Symbol('BREAK');
	private static CONTINUE = Symbol('CONTINUE');
	private returnSignal: { active: boolean; value: unknown } = { active: false, value: null };

	constructor(private ctx: InterpreterContext = {}) {
		this.limits = { ...DEFAULT_LIMITS, ...(ctx.limits ?? {}) };
		this.registerBuiltins();
	}

	async run(program: Program, args: Record<string, unknown> = {}): Promise<unknown> {
		this.vars.set('args', args);
		if (this.ctx.extraVars) for (const [k, v] of Object.entries(this.ctx.extraVars)) this.vars.set(k, v);
		// hoist top-level fn defs so a function can be called before its definition
		for (const stmt of program.body) {
			if (stmt.kind === 'fn') this.fns.set(stmt.name, stmt);
		}
		await this.execBlock(program.body);
		return this.returnSignal.active ? this.returnSignal.value : null;
	}

	private tick(): void {
		this.steps++;
		if (this.steps > this.limits.maxSteps) throw new RuntimeError(`execution budget exceeded (${this.limits.maxSteps} steps), this tool is going to the shadow realm`);
	}

	// Statements only ever return control-flow symbols (RETURN/BREAK/CONTINUE)
	// or undefined. Plain values must NEVER leak out of execBlock, otherwise a
	// var decl would act like a return.
	private async execBlock(stmts: Statement[]): Promise<unknown> {
		for (const stmt of stmts) {
			this.tick();
			const result = await this.execStmt(stmt);
			if (result === Evaluator.RETURN || result === Evaluator.BREAK || result === Evaluator.CONTINUE) return result;
		}
		return undefined;
	}

	private async execStmt(stmt: Statement): Promise<unknown> {
		switch (stmt.kind) {
			case 'var': {
				// never write `this.vars.set(name, await ...)`: the await may swap the
				// vars map (function call save/restore) and the write would land on the
				// stale map
				const value = await this.evalExpr(stmt.value);
				this.vars.set(stmt.name, value);
				return undefined;
			}
			case 'fn':
				this.fns.set(stmt.name, stmt);
				return undefined;
			case 'call': {
				const fn = await this.evalExpr(stmt.name);
				const args = [];
				for (const a of stmt.args) args.push(await this.evalExpr(a));
				await this.invokeFunction(fn, args);
				return undefined;
			}
			case 'return': {
				const value = stmt.value ? await this.evalExpr(stmt.value) : null;
				this.returnSignal.active = true;
				this.returnSignal.value = value;
				return Evaluator.RETURN;
			}
			case 'while': {
				this.loopDepth++;
				try {
					let iterations = 0;
					while (await this.evalExpr(stmt.condition)) {
						this.tick();
						if (++iterations > this.limits.maxLoopIterations) throw new RuntimeError(`while loop exceeded ${this.limits.maxLoopIterations} iterations`);
						const result = await this.execBlock(stmt.body);
						if (result === Evaluator.BREAK) break;
						if (result === Evaluator.CONTINUE) continue;
						if (result === Evaluator.RETURN) return Evaluator.RETURN;
					}
				} finally {
					this.loopDepth--;
				}
				return undefined;
			}
			case 'for': {
				const iterable = await this.evalExpr(stmt.iterable);
				let items: unknown[];
				if (Array.isArray(iterable)) items = iterable;
				else if (typeof iterable === 'string') items = iterable.split('');
				else if (iterable && typeof iterable === 'object') items = Object.keys(iterable);
				else throw new RuntimeError(`cannot iterate over ${iterable === null ? 'null' : typeof iterable}`);
				this.loopDepth++;
				try {
					let iterations = 0;
					for (const item of items) {
						this.tick();
						if (++iterations > this.limits.maxLoopIterations) throw new RuntimeError(`for loop exceeded ${this.limits.maxLoopIterations} iterations`);
						const saved = this.vars.has(stmt.varName);
						const oldVal = this.vars.get(stmt.varName);
						this.vars.set(stmt.varName, item);
						const result = await this.execBlock(stmt.body);
						// restore loop var scoping
						if (saved) this.vars.set(stmt.varName, oldVal);
						else this.vars.delete(stmt.varName);
						if (result === Evaluator.BREAK) break;
						if (result === Evaluator.CONTINUE) continue;
						if (result === Evaluator.RETURN) return Evaluator.RETURN;
					}
				} finally {
					this.loopDepth--;
				}
				return undefined;
			}
			case 'if': {
				const cond = await this.evalExpr(stmt.condition);
				if (cond) return await this.execBlock(stmt.thenBody);
				for (const elif of stmt.elifs) {
					if (await this.evalExpr(elif.condition)) return await this.execBlock(elif.body);
				}
				if (stmt.elseBody) return await this.execBlock(stmt.elseBody);
				return undefined;
			}
			case 'break':
				return Evaluator.BREAK;
			case 'continue':
				return Evaluator.CONTINUE;
			case 'try': {
				try {
					const result = await this.execBlock(stmt.body);
					if (result === Evaluator.BREAK || result === Evaluator.CONTINUE || result === Evaluator.RETURN) return result;
					return undefined;
				} catch (err) {
					if (this.returnSignal.active) throw err;
					if (err instanceof RuntimeError && /exceeded|budget/.test(err.message)) throw err; // limits are not catchable
					if (stmt.catchBody) {
						if (stmt.catchVar) this.vars.set(stmt.catchVar, err instanceof Error ? err.message : String(err));
						const result = await this.execBlock(stmt.catchBody);
						if (result === Evaluator.BREAK || result === Evaluator.CONTINUE || result === Evaluator.RETURN) return result;
					}
					return undefined;
				}
			}
			case 'throw': {
				const value = await this.evalExpr(stmt.value);
				throw new TooLangError(typeof value === 'string' ? value : JSON.stringify(value));
			}
			case 'expr_stmt': {
				await this.evalExpr(stmt.expr);
				return undefined;
			}
		}
	}

	private async evalExpr(expr: Expr): Promise<unknown> {
		switch (expr.kind) {
			case 'string':
				return expr.value;
			case 'number':
				return expr.value;
			case 'boolean':
				return expr.value;
			case 'null':
				return null;
			case 'undefined':
				return undefined;
			case 'identifier':
				return this.getVar(expr.name);

			case 'template':
				return this.interpolate(expr.value);

			case 'binary': {
				const left = await this.evalExpr(expr.left);
				const right = await this.evalExpr(expr.right);
				return this.binaryOp(expr.op, left, right);
			}
			case 'logical': {
				const left = await this.evalExpr(expr.left);
				// short circuit
				if (expr.op === '&&' && !left) return left;
				if (expr.op === '||' && left) return left;
				return await this.evalExpr(expr.right);
			}
			case 'unary': {
				const value = await this.evalExpr(expr.operand);
				if (expr.op === '-') return -Number(value);
				if (expr.op === '!') return !value;
				throw new RuntimeError(`unknown unary operator ${expr.op}`);
			}

			case 'assignment': {
				const value = await this.evalExpr(expr.value);
				let current: unknown;
				if (expr.op !== '=') current = await this.evalExpr(expr.target);
				const next = expr.op === '=' ? value : this.binaryOp(expr.op[0], current, value);
				await this.assignTo(expr.target, next);
				return next;
			}

			// why did i just discovered that you can put {} for declaring vars with same name wtf :sob:
			case 'member': {
				const obj = await this.evalExpr(expr.object);
				return this.getMember(obj, expr.property);
			}
			case 'index': {
				const obj = await this.evalExpr(expr.object);
				const idx = await this.evalExpr(expr.index);
				return this.getIndex(obj, idx);
			}

			case 'method_call': {
				const obj = await this.evalExpr(expr.object);
				const args = [];
				for (const a of expr.args) args.push(await this.evalExpr(a));
				return await this.invokeMethod(obj, expr.method, args);
			}
			case 'call': {
				const fn = await this.evalExpr(expr.name);
				const args = [];
				for (const a of expr.args) args.push(await this.evalExpr(a));
				return await this.invokeFunction(fn, args);
			}

			case 'object': {
				const obj: Record<string, unknown> = {};
				for (const prop of expr.properties) obj[prop.key] = await this.evalExpr(prop.value);
				return obj;
			}
			case 'array': {
				const elements = [];
				for (const e of expr.elements) elements.push(await this.evalExpr(e));
				return elements;
			}
		}
	}

	// ${expr} holes inside template strings
	private interpolate(raw: string): string {
		return raw.replace(/\$\{([^{}]*)\}/g, (_match, code: string) => {
			const tokens = new Lexer(code).tokenize();
			const parser = new Parser(tokens);
			const expr = parser.parseExprPublic();
			const value = this.evalExprSync(expr);
			return value === null || value === undefined ? '' : String(value);
		});
	}

	// sync shim used by interpolate (expressions inside ${} are pure, no awaits needed)
	private evalExprSync(expr: Expr): unknown {
		// small subset: literals, identifiers, member access
		switch (expr.kind) {
			case 'string':
			case 'number':
			case 'boolean':
				return expr.value;
			case 'null':
				return null;
			case 'identifier':
				return this.vars.has(expr.name) ? this.vars.get(expr.name) : undefined;
			case 'member': {
				const obj = this.evalExprSync(expr.object);
				return obj === null || obj === undefined ? undefined : (obj as Record<string, unknown>)[expr.property];
			}
			default:
				throw new RuntimeError('only literals, variables and member access are allowed inside ${...}');
		}
	}

	private binaryOp(op: string, left: unknown, right: unknown): unknown {
		switch (op) {
			case '+': {
				if (typeof left === 'string' || typeof right === 'string') return String(left) + String(right);
				if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
				return Number(left) + Number(right);
			}
			case '-':
				return Number(left) - Number(right);
			case '*':
				return Number(left) * Number(right);
			case '/': {
				const r = Number(right);
				if (r === 0) throw new RuntimeError('division by zero, nice try');
				return Number(left) / r;
			}
			case '%':
				return Number(left) % Number(right);
			case '**':
				return Number(left) ** Number(right);
			case '==':
				return left === right;
			case '!=':
				return left !== right;
			case '<':
				return this.compareValues(left, right) < 0;
			case '>':
				return this.compareValues(left, right) > 0;
			case '<=':
				return this.compareValues(left, right) <= 0;
			case '>=':
				return this.compareValues(left, right) >= 0;
			default:
				throw new RuntimeError(`unknown binary operator ${op}`);
		}
	}

	private compareValues(left: unknown, right: unknown): number {
		if (typeof left === 'number' && typeof right === 'number') return left - right;
		const l = String(left);
		const r = String(right);
		return l < r ? -1 : l > r ? 1 : 0;
	}

	private async assignTo(target: Expr, value: unknown): Promise<void> {
		if (target.kind === 'identifier') {
			this.vars.set(target.name, value);
			return;
		}
		if (target.kind === 'member') {
			const obj = await this.evalExpr(target.object);
			if (obj === null || obj === undefined) throw new RuntimeError(`cannot set property '${target.property}' on ${obj === null ? 'null' : 'undefined'}`);
			(obj as Record<string, unknown>)[target.property] = value;
			return;
		}
		if (target.kind === 'index') {
			const obj = await this.evalExpr(target.object);
			const idx = await this.evalExpr(target.index);
			if (Array.isArray(obj)) {
				const i = Number(idx);
				if (!Number.isInteger(i) || i < 0 || i >= obj.length) throw new RuntimeError(`index ${i} out of bounds for assignment (length ${obj.length})`);
				obj[i] = value;
				return;
			}
			if (obj && typeof obj === 'object') (obj as Record<string, unknown>)[String(idx)] = value;
			else throw new RuntimeError(`cannot index-assign into ${typeof obj}`);
			return;
		}
		throw new RuntimeError('invalid assignment target');
	}

	private getVar(name: string): unknown {
		if (this.vars.has(name)) return this.vars.get(name);
		// user-defined fns live in their own table, resolve them as callable values
		if (this.fns.has(name)) return this.fns.get(name);
		throw new RuntimeError(`undefined variable: ${name}`);
	}

	private getMember(obj: unknown, prop: string): unknown {
		if (obj === null || obj === undefined) throw new RuntimeError(`cannot access property '${prop}' on ${typeof obj}`);
		if (typeof obj === 'object') return (obj as Record<string, unknown>)[prop];
		return undefined;
	}
	private getIndex(obj: unknown, idx: unknown): unknown {
		if (Array.isArray(obj)) {
			const i = Number(idx);
			if (i < 0 || i >= obj.length) throw new RuntimeError(`index ${i} out of bounds (length ${obj.length})`);
			return obj[i];
		}
		if (typeof obj === 'string') {
			const i = Number(idx);
			if (i < 0 || i >= obj.length) throw new RuntimeError(`index ${i} out of bounds (string length ${obj.length})`);
			return obj[i];
		}
		if (obj && typeof obj === 'object') return (obj as Record<string, unknown>)[String(idx)];
		throw new RuntimeError(`cannot index into ${typeof obj}`);
	}

	private async invokeFunction(fn: unknown, args: unknown[]): Promise<unknown> {
		if (typeof fn === 'function') return await fn(...args);
		if (fn && typeof fn === 'object' && 'kind' in fn && fn.kind === 'fn') {
			const func = fn as FnDef;
			if (++this.callDepth > this.limits.maxCallDepth) {
				this.callDepth--;
				throw new RuntimeError(`call depth exceeded ${this.limits.maxCallDepth}, recursion is a hell of a drug`);
			}
			const savedVars = new Map(this.vars);
			const savedReturn = { ...this.returnSignal };
			this.returnSignal = { active: false, value: null };

			for (let i = 0; i < func.params.length; i++) this.vars.set(func.params[i].name, args[i] ?? null);
			const result = await this.execBlock(func.body);
			const returnValue = this.returnSignal.active ? this.returnSignal.value : result;

			this.vars = savedVars;
			this.returnSignal = savedReturn;
			this.callDepth--;
			return returnValue;
		}
		throw new RuntimeError(`cannot call ${typeof fn}`);
	}

	private async invokeMethod(obj: unknown, method: string, args: unknown[]): Promise<unknown> {
		if (typeof obj === 'string') return stringMethod(obj, method, args);
		if (Array.isArray(obj)) return arrayMethod(obj, method, args);
		if (typeof obj === 'number') return numberMethod(obj, method, args);
		if (obj && typeof obj === 'object') {
			// modules (http, json, docker, ...) are plain objects holding functions:
			// if the property is callable, it is a module/builtin method call
			const candidate = (obj as Record<string, unknown>)[method];
			if (typeof candidate === 'function') return await candidate(...args);
			return objectMethod(obj as Record<string, unknown>, method, args);
		}
		if (obj === null || obj === undefined) throw new RuntimeError(`no method '${method}' on ${obj === null ? 'null' : 'undefined'}`);
		throw new RuntimeError(`no method '${method}' on ${typeof obj}`);
	}

	private registerBuiltins(): void {
		this.vars.set('http', httpModule(this.ctx.config));
		this.vars.set('json', jsonModule());
		this.vars.set('node', nodejsModule(this.ctx.config));
		this.vars.set('nodejs', nodejsModule(this.ctx.config));
		this.vars.set('Array', arrayModule());
		this.vars.set('Object', objectModule());
		this.vars.set('math', mathModule());
		this.vars.set('time', timeModule());
		this.vars.set('codec', codecModule());
		this.vars.set('regex', regexModule());
		this.vars.set('fs', fsModule(this.ctx.config));
		this.vars.set('log', logModule());
		this.vars.set('sys', sysModule());
		this.vars.set('env', envModule(this.ctx.envAccess === true));

		this.vars.set(
			'docker',
			dockerModule(() => {
				const cfg = (this.ctx.config ?? {}) as Record<string, unknown>;
				const raw = (typeof cfg.docker === 'object' && cfg.docker !== null ? cfg.docker : {}) as Record<string, unknown>;
				// the fs sandbox config rides along: docker.cp jails its host-side
				// paths in the same root the fs builtin uses
				const fsRaw = (typeof cfg.fs === 'object' && cfg.fs !== null ? cfg.fs : {}) as Record<string, unknown>;
				return {
					enabled: raw.enabled === true,
					host: typeof raw.host === 'string' ? raw.host : undefined,
					allowedPorts: Array.isArray(raw.allowedPorts) ? raw.allowedPorts.map(String) : undefined,
					disallowedImages: Array.isArray(raw.disallowedImages) ? raw.disallowedImages.map(String) : undefined,
					allowedImages: Array.isArray(raw.allowedImages) ? raw.allowedImages.map(String) : undefined,
					maxContainers: typeof raw.maxContainers === 'number' ? raw.maxContainers : 100,
					defaultImage: typeof raw.defaultImage === 'string' ? raw.defaultImage : 'debian:bookworm',
					allowedVolumePaths: Array.isArray(raw.allowedVolumePaths) ? raw.allowedVolumePaths.map(String) : undefined,
					bindAddress: typeof raw.bindAddress === 'string' ? raw.bindAddress : undefined,
					volumeRoot: typeof raw.volumeRoot === 'string' && raw.volumeRoot.length > 0 ? raw.volumeRoot : undefined,
					fsRoot: typeof fsRaw.root === 'string' && fsRaw.root.length > 0 ? fsRaw.root : undefined,
					fsMaxFileSize: typeof fsRaw.maxFileSize === 'number' ? fsRaw.maxFileSize : undefined
				};
			})
		);
		this.vars.set(
			'discord',
			discordModule(() => {
				if (!this.ctx.discord) throw new RuntimeError('discord module requires a Discord.js client. Pass it via InterpreterContext.');
				return this.ctx.discord;
			})
		);
		this.vars.set(
			'agent',
			agentModule(() => {
				if (!this.ctx.agent) throw new RuntimeError('agent module requires an Agent instance. Pass it via InterpreterContext.');
				return this.ctx.agent;
			})
		);
	}
}
