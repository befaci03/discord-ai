/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.

import {
	Program,
	ToolHeader, ToolArg,
	Statement,
	Expr, VarDecl,
	WhileLoop, ForInLoop, FnDef,
	ReturnStmt, CallStmt, IfStmt, ExprStmt,
	BreakStmt, ContinueStmt, TryStmt, ThrowStmt,
	ArrayLiteral, ObjectLiteral
} from "./ast.js";
import { Token, TokenType } from "./lexer.js";

export class ParseError extends Error {
	constructor(message: string, token: Token) {
		super(`Parse error at line ${token.line}:${token.col}: ${message}`);
		this.name = "ParseError";
	}
}

export class Parser {
	private pos = 0;

	constructor(private tokens: Token[]) {}

	parse(): Program {
		// the header may already have been stripped by parseToolSource(), so only
		// consume it when it is actually there
		let header: ToolHeader = { name: "", description: "", arguments: [] };
		if (this.check(TokenType.LBrace)) {
			header = this.parseToolHeader();
			this.expect(TokenType.ToolDelim, "expected delimiter after tool header");
		}
		const body = this.parseBodyUntil(TokenType.Eof);
		return { header, body }
	}

	private parseToolHeader(): ToolHeader {
		this.expect(TokenType.LBrace, "tool header must start with {");
		const obj: Record<string, unknown> = {};
		while (!this.check(TokenType.RBrace) && !this.check(TokenType.Eof)) {
			const key = this.expect(TokenType.String, "expected string key").value;
			this.expect(TokenType.Colon, "expected : after key");
			const val = this.parseJsonValue();
			obj[key] = val;
			if (this.check(TokenType.Comma)) this.advance();
		}
		this.expect(TokenType.RBrace, "tool header must end with }");

		return { name: String(obj.name ?? ""), description: String(obj.description ?? ""), arguments: Array.isArray(obj.arguments) ? (obj.arguments as ToolArg[]) : [] }
	}

	private parseJsonValue(): unknown {
		const tok = this.current();
		if (tok.type === TokenType.String) return this.advance().value;
		if (tok.type === TokenType.Number) return Number(this.advance().value);
		if (tok.type === TokenType.True) {
			this.advance();
			return true;
		}
		if (tok.type === TokenType.False) {
			this.advance();
			return false;
		}
		if (tok.type === TokenType.Null) {
			this.advance();
			return null;
		}
		if (tok.type === TokenType.LBracket) return this.parseJsonArray();
		if (tok.type === TokenType.LBrace) return this.parseJsonObject();
		throw new ParseError(`unexpected token in JSON header: ${tok.value}`, tok);
	}

	private parseJsonArray(): unknown[] {
		this.advance();
		const arr: unknown[] = [];
		while (!this.check(TokenType.RBracket) && !this.check(TokenType.Eof)) {
			arr.push(this.parseJsonValue());
			if (this.check(TokenType.Comma)) this.advance();
		}
		this.expect(TokenType.RBracket, "expected ]");
		return arr;
	}

	private parseJsonObject(): Record<string, unknown> {
		this.advance();
		const obj: Record<string, unknown> = {};
		while (!this.check(TokenType.RBrace) && !this.check(TokenType.Eof)) {
			const key = this.expect(TokenType.String, "expected string key").value;
			this.expect(TokenType.Colon, "expected :");
			obj[key] = this.parseJsonValue();
			if (this.check(TokenType.Comma)) this.advance();
		}
		this.expect(TokenType.RBrace, "expected }");
		return obj;
	}

	private parseBodyUntil(end: TokenType): Statement[] {
		const stmts: Statement[] = [];
		while (!this.check(end) && !this.check(TokenType.Eof)) {
			stmts.push(this.parseStatement());
		}
		return stmts;
	}

	private parseBlockBody(): Statement[] {
		const stmts: Statement[] = [];
		while (!this.check(TokenType.Close) && !this.check(TokenType.Eof) && !this.check(TokenType.Else) && !this.check(TokenType.Elif) && !this.check(TokenType.Catch)) {
			stmts.push(this.parseStatement());
		}
		return stmts;
	}

	private parseStatement(): Statement {
		const tok = this.current();
		if (tok.type === TokenType.Set) return this.parseVarDecl();
		if (tok.type === TokenType.Fn) return this.parseFnDef();
		if (tok.type === TokenType.Return) return this.parseReturn();
		if (tok.type === TokenType.While) return this.parseWhile();
		if (tok.type === TokenType.For) return this.parseForIn();
		if (tok.type === TokenType.If) return this.parseIf();
		if (tok.type === TokenType.Break) {
			this.advance();
			return { kind: "break" } satisfies BreakStmt
		}
		if (tok.type === TokenType.Continue) {
			this.advance();
			return { kind: "continue" } satisfies ContinueStmt
		}
		if (tok.type === TokenType.Try) return this.parseTry();
		if (tok.type === TokenType.Throw) {
			this.advance();
			return { kind: "throw", value: this.parseExpr() } satisfies ThrowStmt
		}
		if (tok.type === TokenType.Call) return this.parseCallStmt();
		return this.parseExprStmt();
	}

	private parseVarDecl(): VarDecl {
		this.expect(TokenType.Set, "set");
		this.expect(TokenType.Var, "var");
		const name = this.expect(TokenType.Ident, "variable name").value;
		this.expect(TokenType.To, "to");
		const value = this.parseExpr();
		return { kind: "var", name, value }
	}

	private parseFnDef(): FnDef {
		this.expect(TokenType.Fn, "fn");
		const name = this.expect(TokenType.Ident, "function name").value;
		this.expect(TokenType.With, "with");
		this.expect(TokenType.LParen, "(");
		const params: { name: string; type: string }[] = [];
		if (!this.check(TokenType.RParen)) {
			do {
				const pName = this.expect(TokenType.Ident, "parameter name").value;
				this.expect(TokenType.Colon, ":");
				const pType = this.expect(TokenType.Ident, "parameter type").value;
				params.push({ name: pName, type: pType });
			} while (this.match(TokenType.Comma));
		}
		this.expect(TokenType.RParen, ")");
		this.expect(TokenType.Do, "do");
		const body = this.parseBlockBody();
		this.expect(TokenType.Close, "close");
		return { kind: "fn", name, params, body }
	}

	private parseReturn(): ReturnStmt {
		this.expect(TokenType.Return, "return");
		if (this.check(TokenType.LParen)) {
			this.advance();
			if (this.check(TokenType.RParen)) {
				this.advance();
				return { kind: "return", value: null }
			}
			const value = this.parseExpr();
			this.expect(TokenType.RParen, ")");
			return { kind: "return", value }
		}
		const value = this.parseExpr();
		return { kind: "return", value }
	}

	private parseCallStmt(): CallStmt {
		this.expect(TokenType.Call, "call");
		this.expect(TokenType.LParen, "(");
		const name = this.parseExpr();
		// after the callee, args (if any) start with a comma: call(f, a, b)
		const args: Expr[] = [];
		while (this.match(TokenType.Comma)) {
			if (this.check(TokenType.RParen)) break; // tolerate trailing comma
			args.push(this.parseExpr());
		}
		this.expect(TokenType.RParen, ")");
		return { kind: "call", name, args }
	}

	private parseWhile(): WhileLoop {
		this.expect(TokenType.While, "while");
		const condition = this.parseExpr();
		this.expect(TokenType.Do, "do");
		const body = this.parseBlockBody();
		this.expect(TokenType.Close, "close");
		return { kind: "while", condition, body }
	}

	private parseForIn(): ForInLoop {
		this.expect(TokenType.For, "for");
		const varName = this.expect(TokenType.Ident, "loop variable name").value;
		this.expect(TokenType.In, "in");
		const iterable = this.parseExpr();
		this.expect(TokenType.Do, "do");
		const body = this.parseBlockBody();
		this.expect(TokenType.Close, "close");
		return { kind: "for", varName, iterable, body }
	}

	private parseIf(): IfStmt {
		this.expect(TokenType.If, "if");
		const condition = this.parseExpr();
		this.expect(TokenType.Then, "then");
		const thenBody = this.parseBlockBody();
		const elifs: { condition: Expr; body: Statement[] }[] = [];
		while (this.check(TokenType.Elif)) {
			this.advance();
			const cond = this.parseExpr();
			this.expect(TokenType.Then, "then");
			elifs.push({ condition: cond, body: this.parseBlockBody() });
		}
		let elseBody: Statement[] | null = null;
		if (this.check(TokenType.Else)) {
			this.advance();
			elseBody = this.parseBlockBody();
		}
		this.expect(TokenType.Close, "close");
		return { kind: "if", condition, thenBody, elifs, elseBody }
	}

	private parseTry(): TryStmt {
		this.expect(TokenType.Try, "try");
		this.expect(TokenType.Do, "do");
		const body = this.parseBlockBody();
		let catchVar: string | null = null;
		let catchBody: Statement[] | null = null;
		if (this.check(TokenType.Catch)) {
			this.advance();
			if (this.check(TokenType.Ident)) catchVar = this.advance().value;
			this.expect(TokenType.Do, "do");
			catchBody = this.parseBlockBody();
		}
		this.expect(TokenType.Close, "close");
		return { kind: "try", body, catchVar, catchBody }
	}

	private parseExprStmt(): ExprStmt { return { kind: "expr_stmt", expr: this.parseExpr() } }

	/** Public entry used by the evaluator to parse ${...} interpolation holes. */
	public parseExprPublic(): Expr { return this.parseExpr() }

	private parseExpr(): Expr { return this.parseAssignment() }

	// precedence climbing, lowest to highest
	private static readonly PRECEDENCE: Partial<Record<TokenType, number>> = {
		[TokenType.Or]: 1,
		[TokenType.And]: 2,
		[TokenType.Eq]: 3,
		[TokenType.Neq]: 3,
		[TokenType.Lt]: 4,
		[TokenType.Gt]: 4,
		[TokenType.Lte]: 4,
		[TokenType.Gte]: 4,
		[TokenType.Plus]: 5,
		[TokenType.Minus]: 5,
		[TokenType.Star]: 6,
		[TokenType.Slash]: 6,
		[TokenType.Percent]: 6,
		[TokenType.Power]: 7,
	};

	private parseAssignment(): Expr {
		const left = this.parseBinary(0);
		const assignOps = [TokenType.Assign, TokenType.PlusAssign, TokenType.MinusAssign, TokenType.StarAssign, TokenType.SlashAssign, TokenType.PercentAssign];
		if (assignOps.includes(this.current().type)) {
			const opTok = this.advance();
			const value = this.parseAssignment();
			if (left.kind !== "identifier" && left.kind !== "member" && left.kind !== "index") {
				throw new ParseError("invalid assignment target", opTok);
			}
			return { kind: "assignment", op: opTok.value as "=" | "+=" | "-=" | "*=" | "/=" | "%=", target: left, value }
		}
		return left;
	}

	private parseBinary(minPrec: number): Expr {
		let left = this.parseUnary();
		while (true) {
			const tok = this.current();
			const prec = Parser.PRECEDENCE[tok.type];
			if (prec === undefined || prec < minPrec) break;
			this.advance();
			if (tok.type === TokenType.And || tok.type === TokenType.Or) {
				const right = this.parseBinary(prec + 1);
				left = { kind: "logical", op: tok.value as "&&" | "||", left, right }
			} else {
				// ** is right-associative
				const nextMin = tok.type === TokenType.Power ? prec : prec + 1;
				const right = this.parseBinary(nextMin);
				left = { kind: "binary", op: tok.value, left, right }
			}
		}
		return left;
	}

	private parseUnary(): Expr {
		const tok = this.current();
		if (tok.type === TokenType.Minus) {
			this.advance();
			return { kind: "unary", op: "-", operand: this.parseUnary() }
		}
		if (tok.type === TokenType.Not) {
			this.advance();
			return { kind: "unary", op: "!", operand: this.parseUnary() }
		}
		return this.parsePostfix();
	}

	private parsePostfix(): Expr {
		let expr = this.parsePrimary();
		while (this.check(TokenType.LParen) || this.check(TokenType.Dot) || this.check(TokenType.LBracket)) {
			if (this.check(TokenType.LParen)) {
				this.advance();
				// first arg comes right after (, then , arg pairs
				const args: Expr[] = [];
				if (!this.check(TokenType.RParen)) {
					args.push(this.parseExpr());
					while (this.match(TokenType.Comma)) {
						if (this.check(TokenType.RParen)) break; // tolerate trailing comma
						args.push(this.parseExpr());
					}
				}
				this.expect(TokenType.RParen, ")");
				expr = { kind: "call", name: expr, args }
			} else if (this.check(TokenType.Dot)) {
				this.advance();
				// after a dot, keyword-looking tokens (json.to, args.in, ...) are property names
				const prop = this.parsePropertyOrKeyword();
				if (this.check(TokenType.LParen)) {
					this.advance();
					const args: Expr[] = [];
					if (!this.check(TokenType.RParen)) {
						do {
							args.push(this.parseExpr());
						} while (this.match(TokenType.Comma));
					}
					this.expect(TokenType.RParen, ")");
					expr = { kind: "method_call", object: expr, method: prop, args }
				} else expr = { kind: "member", object: expr, property: prop }
			} else if (this.check(TokenType.LBracket)) {
				this.advance();
				const index = this.parseExpr();
				this.expect(TokenType.RBracket, "]");
				expr = { kind: "index", object: expr, index }
			}
		}
		return expr;
	}

	/** After a dot, keywords like `to`/`in`/`do` are valid property names. */
	private parsePropertyOrKeyword(): string {
		const tok = this.current();
		if (tok.type === TokenType.Ident) return this.advance().value;
		// keyword tokens carry their textual value (e.g. "to"), accept those too
		if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tok.value) && tok.value !== "") return this.advance().value;
		throw new ParseError(`expected property name, got "${tok.value || tok.type}"`, tok);
	}

	private parsePrimary(): Expr {
		const tok = this.current();

		if (tok.type === TokenType.String) {
			this.advance();
			return { kind: "string", value: tok.value };
		}
		if (tok.type === TokenType.Template) {
			this.advance();
			return { kind: "template", value: tok.value };
		}
		if (tok.type === TokenType.Number) {
			this.advance();
			return { kind: "number", value: Number(tok.value) };
		}

		if (tok.type === TokenType.True) {
			this.advance();
			return { kind: "boolean", value: true };
		}
		if (tok.type === TokenType.False) {
			this.advance();
			return { kind: "boolean", value: false };
		}
		if (tok.type === TokenType.Null) {
			this.advance();
			return { kind: "null" };
		}

		if (tok.type === TokenType.LBracket) {
			return this.parseArrayLiteral();
		}
		if (tok.type === TokenType.LBrace) {
			return this.parseObjectLiteral();
		}
		if (tok.type === TokenType.LParen) {
			this.advance();
			const expr = this.parseExpr();
			this.expect(TokenType.RParen, ")");
			return expr;
		}

		if (tok.type === TokenType.Ident) {
			this.advance();
			return { kind: "identifier", name: tok.value }
		}

		// `call(f, x)` used as an expression: set var x to call(f, 1)
		if (tok.type === TokenType.Call) {
			this.advance();
			this.expect(TokenType.LParen, "(");
			const name = this.parseExpr();
			const args: Expr[] = [];
			while (this.match(TokenType.Comma)) {
				if (this.check(TokenType.RParen)) break;
				args.push(this.parseExpr());
			}
			this.expect(TokenType.RParen, ")");
			return { kind: "call", name, args }
		}

		throw new ParseError(`unexpected token: ${tok.value || tok.type}`, tok);
	}

	private parseArrayLiteral(): ArrayLiteral {
		this.expect(TokenType.LBracket, "[");
		const elements: Expr[] = [];
		if (!this.check(TokenType.RBracket)) {
			elements.push(this.parseExpr());
			while (this.match(TokenType.Comma)) {
				if (this.check(TokenType.RBracket)) break; // tolerate trailing comma
				elements.push(this.parseExpr());
			}
		}
		this.expect(TokenType.RBracket, "]");
		return { kind: "array", elements }
	}

	private parseObjectLiteral(): ObjectLiteral {
		this.expect(TokenType.LBrace, "{");
		const properties: { key: string; value: Expr }[] = [];
		const parseKey = (): string => {
			const keyTok = this.current();
			if (keyTok.type === TokenType.String || keyTok.type === TokenType.Template || keyTok.type === TokenType.Ident) {
				return this.advance().value;
			}
			throw new ParseError(`expected string or identifier key, got ${keyTok.value}`, keyTok);
		};
		if (!this.check(TokenType.RBrace)) {
			do {
				const key = parseKey();
				this.expect(TokenType.Colon, ":");
				const value = this.parseExpr();
				properties.push({ key, value });
				if (this.check(TokenType.RBrace)) break; // tolerate trailing comma
			} while (this.match(TokenType.Comma));
		}
		this.expect(TokenType.RBrace, "}");
		return { kind: "object", properties }
	}

	private current(): Token { return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1] }

	private advance(): Token {
		const tok = this.current();
		if (this.pos < this.tokens.length) this.pos++;
		return tok;
	}

	private check(type: TokenType): boolean { return this.current().type === type }

	private match(type: TokenType): boolean {
		if (this.check(type)) {
			this.advance();
			return true;
		}
		return false;
	}

	private expect(type: TokenType, desc: string): Token {
		if (!this.check(type)) throw new ParseError(`${desc}, got "${this.current().value || this.current().type}"`, this.current());
		return this.advance();
	}
}
