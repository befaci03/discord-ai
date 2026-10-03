/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// TooLang lexer/tokenizer

export enum TokenType {
	String = "string",
	Number = "number",
	Template = "template", // string containing ${expr} holes
	True = "true",
	False = "false",
	Null = "null",

	Ident = "ident",
	Set = "set",
	Var = "var",
	To = "to",
	Fn = "fn",
	With = "with",
	Do = "do",
	Close = "close",
	Return = "return",
	Call = "call",
	While = "while",
	If = "if",
	Elif = "elif",
	Then = "then",
	Else = "else",
	For = "for",
	In = "in",
	Break = "break",
	Continue = "continue",
	Try = "try",
	Catch = "catch",
	Throw = "throw",

	// operators
	Plus = "+",
	Minus = "-",
	Star = "*",
	Power = "**",
	Slash = "/",
	Percent = "%",
	Eq = "==",
	Neq = "!=",
	Lte = "<=",
	Gte = ">=",
	Lt = "<",
	Gt = ">",
	And = "&&",
	Or = "||",
	Not = "!",
	Assign = "=",
	PlusAssign = "+=",
	MinusAssign = "-=",
	StarAssign = "*=",
	SlashAssign = "/=",
	PercentAssign = "%=",

	LParen = "(",
	RParen = ")",
	LBracket = "[",
	RBracket = "]",
	LBrace = "{",
	RBrace = "}",
	Colon = ":",
	Comma = ",",
	Dot = ".",
	Dollar = "$",

	ToolDelim = "ToolDelim", // ¤
	Eof = "EOF",
	Comment = "--=",
}

export interface Token {
	type: TokenType;
	value: string;
	line: number;
	col: number;
}

const KEYWORDS: Record<string, TokenType> = {
	set: TokenType.Set,
	var: TokenType.Var,
	to: TokenType.To,
	fn: TokenType.Fn,
	with: TokenType.With,
	do: TokenType.Do,
	close: TokenType.Close,
	return: TokenType.Return,
	call: TokenType.Call,
	while: TokenType.While,
	if: TokenType.If,
	elif: TokenType.Elif,
	then: TokenType.Then,
	else: TokenType.Else,
	for: TokenType.For,
	in: TokenType.In,
	break: TokenType.Break,
	continue: TokenType.Continue,
	try: TokenType.Try,
	catch: TokenType.Catch,
	throw: TokenType.Throw,
	true: TokenType.True,
	false: TokenType.False,
	null: TokenType.Null,
	and: TokenType.And,
	or: TokenType.Or,
	not: TokenType.Not,
};

export class Lexer {
	private pos = 0;
	private line = 1;
	private col = 1;

	constructor(private src: string) {}

	tokenize(): Token[] {
		const tokens: Token[] = [];
		while (this.pos < this.src.length) {
			this.skipWhitespaceAndComments();
			if (this.pos >= this.src.length) break;
			const tok = this.nextToken();
			if (tok) tokens.push(tok);
		}
		tokens.push({
			type: TokenType.Eof,
			value: "",
			line: this.line,
			col: this.col,
		});
		return tokens;
	}

	private peek(offset = 0): string { return this.src[this.pos + offset] ?? "" }

	private advance(): string {
		const ch = this.src[this.pos++];
		if (ch === "\n") {
			this.line++;
			this.col = 1;
		} else this.col++;
		return ch;
	}

	private skipWhitespaceAndComments(): void {
		while (this.pos < this.src.length) {
			const ch = this.peek();
			if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
				this.advance();
				continue;
			}
			// comments: --= and --# (line comments)
			if (ch === "-" && this.peek(1) === "-" && (this.peek(2) === "=" || this.peek(2) === "#")) {
				this.skipLine();
				continue;
			}
			break;
		}
	}

	private skipLine(): void {
		while (this.pos < this.src.length && this.peek() !== "\n") {
			this.advance();
		}
	}

	private nextToken(): Token | null {
		const line = this.line;
		const col = this.col;
		const ch = this.peek();

		if (ch === "¤") {
			this.advance();
			return { type: TokenType.ToolDelim, value: "¤", line, col };
		}

		// punctuation
		if (ch === "(") { this.advance(); return { type: TokenType.LParen, value: "(", line, col } }
		if (ch === ")") { this.advance(); return { type: TokenType.RParen, value: ")", line, col } }
		if (ch === "[") { this.advance(); return { type: TokenType.LBracket, value: "[", line, col } }
		if (ch === "]") { this.advance(); return { type: TokenType.RBracket, value: "]", line, col } }
		if (ch === "{") { this.advance(); return { type: TokenType.LBrace, value: "{", line, col } }
		if (ch === "}") { this.advance(); return { type: TokenType.RBrace, value: "}", line, col } }
		if (ch === ":") { this.advance(); return { type: TokenType.Colon, value: ":", line, col } }
		if (ch === ",") { this.advance(); return { type: TokenType.Comma, value: ",", line, col } }
		if (ch === ".") { this.advance(); return { type: TokenType.Dot, value: ".", line, col } }
		if (ch === "$") { this.advance(); return { type: TokenType.Dollar, value: "$", line, col } }

		if (ch === '"') return this.readString(line, col);

		if (ch === "*" && this.peek(1) === "*") { this.advance(); this.advance(); return { type: TokenType.Power, value: "**", line, col } }

		// two-char operators (must come before their one-char prefixes)
		if (ch === "=" && this.peek(1) === "=") { this.advance(); this.advance(); return { type: TokenType.Eq, value: "==", line, col } }
		if (ch === "!" && this.peek(1) === "=") { this.advance(); this.advance(); return { type: TokenType.Neq, value: "!=", line, col } }
		if (ch === "<" && this.peek(1) === "=") { this.advance(); this.advance(); return { type: TokenType.Lte, value: "<=", line, col } }
		if (ch === ">" && this.peek(1) === "=") { this.advance(); this.advance(); return { type: TokenType.Gte, value: ">=", line, col } }
		if (ch === "&" && this.peek(1) === "&") { this.advance(); this.advance(); return { type: TokenType.And, value: "&&", line, col } }
		if (ch === "|" && this.peek(1) === "|") { this.advance(); this.advance(); return { type: TokenType.Or, value: "||", line, col } }

		// compound assignment (but never inside a comment, those were skipped above)
		if (ch === "+" && this.peek(1) === "=") { this.advance(); this.advance(); return { type: TokenType.PlusAssign, value: "+=", line, col } }
		if (ch === "-" && this.peek(1) === "=") { this.advance(); this.advance(); return { type: TokenType.MinusAssign, value: "-=", line, col } }
		if (ch === "*" && this.peek(1) === "=") { this.advance(); this.advance(); return { type: TokenType.StarAssign, value: "*=", line, col } }
		if (ch === "/" && this.peek(1) === "=") { this.advance(); this.advance(); return { type: TokenType.SlashAssign, value: "/=", line, col } }
		if (ch === "%" && this.peek(1) === "=") { this.advance(); this.advance(); return { type: TokenType.PercentAssign, value: "%=", line, col } }

		// one-char operators
		if (ch === "+") { this.advance(); return { type: TokenType.Plus, value: "+", line, col } }
		if (ch === "-") { this.advance(); return { type: TokenType.Minus, value: "-", line, col } }
		if (ch === "*") { this.advance(); return { type: TokenType.Star, value: "*", line, col } }
		if (ch === "/") { this.advance(); return { type: TokenType.Slash, value: "/", line, col } }
		if (ch === "%") { this.advance(); return { type: TokenType.Percent, value: "%", line, col } }
		if (ch === "=") { this.advance(); return { type: TokenType.Assign, value: "=", line, col } }
		if (ch === "!") { this.advance(); return { type: TokenType.Not, value: "!", line, col } }
		if (ch === "<") { this.advance(); return { type: TokenType.Lt, value: "<", line, col } }
		if (ch === ">") { this.advance(); return { type: TokenType.Gt, value: ">", line, col } }

		// negative numbers are handled by the parser via unary minus
		if (this.isDigit(ch)) return this.readNumber(line, col);
		if (this.isIdentStart(ch)) return this.readIdent(line, col);

		this.advance();
		return null;
	}

	private readString(line: number, col: number): Token {
		this.advance();
		let value = "";
		let hasTemplate = false;
		while (this.pos < this.src.length && this.peek() !== '"') {
			if (this.peek() === "\\") {
				this.advance();
				const esc = this.advance();
				switch (esc) {
					case "n": value += "\n"; break;
					case "t": value += "\t"; break;
					case "r": value += "\r"; break;
					case "\\": value += "\\"; break;
					case '"': value += '"'; break;
					case "$": value += "$"; break;
					default: value += esc; break;
				}
			} else if (this.peek() === "$" && this.peek(1) === "{") {
				// interpolation hole: grab raw text up to the matching }
				this.advance(); this.advance();
				let depth = 1;
				let hole = "";
				while (this.pos < this.src.length && depth > 0) {
					const c = this.peek();
					if (c === "{") depth++;
					if (c === "}") {
						depth--;
						if (depth === 0) { this.advance(); break; }
					}
					if (c === "\n") throw new Error(`unterminated \${...} in string at line ${line}:${col}`);
					hole += this.advance();
				}
				if (depth > 0) throw new Error(`unterminated \${...} in string at line ${line}:${col}`);
				value += "${" + hole + "}";
				hasTemplate = true;
			} else {
				value += this.advance();
			}
		}
		if (this.pos >= this.src.length) throw new Error(`unterminated string at line ${line}:${col}`);
		this.advance(); // closing quote
		return { type: hasTemplate ? TokenType.Template : TokenType.String, value, line, col }
	}

	private readNumber(line: number, col: number): Token {
		let value = "";
		if (this.peek() === "-") value += this.advance();
		while (this.pos < this.src.length && this.isDigit(this.peek())) value += this.advance();
		if (this.pos < this.src.length && this.peek() === "." && this.isDigit(this.peek(1))) {
			value += this.advance();
			while (this.pos < this.src.length && this.isDigit(this.peek())) value += this.advance();
		}
		return { type: TokenType.Number, value, line, col }
	}

	private readIdent(line: number, col: number): Token {
		let value = "";
		while (this.pos < this.src.length && this.isIdentPart(this.peek())) value += this.advance();
		const type = KEYWORDS[value] ?? TokenType.Ident;
		return { type, value, line, col }
	}

	private isDigit(ch: string): boolean { return ch >= "0" && ch <= "9" }

	private isIdentStart(ch: string): boolean { return ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_") }

	private isIdentPart(ch: string): boolean { return this.isIdentStart(ch) || this.isDigit(ch) }
}
