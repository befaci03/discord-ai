/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// TooLang interpreter entry point

import { readFileSync } from "node:fs";
import { Lexer } from "./lexer.js";
import { Parser } from "./parser.js";
import { Evaluator, RuntimeError } from "./evaluator.js";
import { resolveLimits, type InterpreterLimits } from "./limits.js";
import { ToolDef } from "../llmproto/types.js";
export type { Program, ToolHeader, Statement, Expr } from "./ast.js";
export { ParseError } from "./parser.js";
export { RuntimeError, TooLangError, type InterpreterContext } from "./evaluator.js";
export { resolveLimits, type InterpreterLimits } from "./limits.js";

import type { InterpreterContext } from "./evaluator.js";

export interface ToolResult {
	success: boolean;
	data: unknown;
	error?: string;
}
export interface ParsedTool {
	header: ToolDef;
	code: string;
}

export function parseToolFile(filePath: string): ParsedTool {
	const raw = readFileSync(filePath, "utf-8");
	return parseToolSource(raw);
}
export function parseToolSource(source: string): ParsedTool {
	const delimIdx = source.indexOf("¤");
	if (delimIdx === -1) throw new Error("TooLang source must contain a delimiter after the tool header");

	const jsonPart = source.slice(0, delimIdx).trim();
	const codePart = source.slice(delimIdx + 1).trim();
	const header = JSON.parse(jsonPart) as ToolDef;
	return { header, code: codePart }
}

export async function executeTool(filePath: string, args: Record<string, unknown>, ctx: InterpreterContext = {}): Promise<ToolResult> {
	const raw = readFileSync(filePath, "utf-8");
	return await executeToolSource(raw, args, ctx);
}

export async function executeToolSource(source: string, args: Record<string, unknown>, ctx: InterpreterContext = {}): Promise<ToolResult> {
	try {
		const { code } = parseToolSource(source);
		const data = await runFromSource(code, args, ctx);
		return { success: true, data }
	} catch (err) {
		if (err instanceof RuntimeError || err instanceof Error) return { success: false, data: null, error: err.message };
		return { success: false, data: null, error: String(err) }
	}
}

export async function runFromSource(code: string, args: Record<string, unknown>, ctx: InterpreterContext = {}): Promise<unknown> {
	const lexer = new Lexer(code);
	const tokens = lexer.tokenize();
	const parser = new Parser(tokens);
	const program = parser.parse();
	const evaluator = new Evaluator({
		...ctx,
		limits: resolveLimits(ctx.limits),
	});
	return await evaluator.run(program, args);
}

export function validateToolArgs(header: ToolDef, args: Record<string, unknown>): string[] {
	const errors: string[] = [];
	for (const argDef of header.arguments) {
		const val = args[argDef.name];
		if (val === undefined || val === null) {
			errors.push(`Missing required argument: ${argDef.name}`);
			continue;
		}
		switch (argDef.type) {
			case "string":
				if (typeof val !== "string") errors.push(`Argument '${argDef.name}' must be a string, got ${typeof val}`);
				break;
			case "number":
				if (typeof val !== "number") errors.push(`Argument '${argDef.name}' must be a number, got ${typeof val}`);
				break;
			case "boolean":
				if (typeof val !== "boolean") errors.push(`Argument '${argDef.name}' must be a boolean, got ${typeof val}`);
				break;
		}
		if (typeof val === "string" && argDef.disallow?.length > 0)
			if (argDef.disallow.includes(val)) errors.push(`Argument '${argDef.name}' disallows value: '${val}'`);
	}
	return errors;
}
