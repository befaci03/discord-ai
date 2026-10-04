/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.

export interface ToolHeader {
	name: string;
	description: string;
	arguments: ToolArg[];
}
export interface ToolArg {
	type: 'string' | 'number' | 'boolean';
	name: string;
	description: string;
	disallow: string[];
	/** true = the caller may omit it; it arrives as '' / 0 / false */
	optional?: boolean;
}
export interface Program {
	header: ToolHeader;
	body: Statement[];
}

export type Expr =
	| StringLiteral
	| NumberLiteral
	| BooleanLiteral
	| NullLiteral
	| UndefinedLiteral
	| Identifier
	| TemplateLiteral
	| BinaryExpr
	| UnaryExpr
	| LogicalExpr
	| AssignmentExpr
	| MemberAccess
	| IndexAccess
	| MethodCall
	| FunctionCall
	| ArrayLiteral
	| ObjectLiteral;

export interface StringLiteral {
	kind: 'string';
	value: string;
}
export interface NumberLiteral {
	kind: 'number';
	value: number;
}
export interface BooleanLiteral {
	kind: 'boolean';
	value: boolean;
}
export interface NullLiteral {
	kind: 'null';
}
export interface UndefinedLiteral {
	kind: 'undefined';
}

export interface TemplateLiteral {
	kind: 'template';
	value: string; // raw text with ${expr} holes
}
export interface Identifier {
	kind: 'identifier';
	name: string;
}
export interface BinaryExpr {
	kind: 'binary';
	op: string;
	left: Expr;
	right: Expr;
}
export interface UnaryExpr {
	kind: 'unary';
	op: string;
	operand: Expr;
}
export interface LogicalExpr {
	kind: 'logical';
	op: '&&' | '||';
	left: Expr;
	right: Expr;
}
export interface AssignmentExpr {
	kind: 'assignment';
	op: '=' | '+=' | '-=' | '*=' | '/=' | '%=';
	target: Expr; // identifier, member or index
	value: Expr;
}

export interface MemberAccess {
	kind: 'member';
	object: Expr;
	property: string;
}
export interface IndexAccess {
	kind: 'index';
	object: Expr;
	index: Expr;
}

export interface MethodCall {
	kind: 'method_call';
	object: Expr;
	method: string;
	args: Expr[];
}
export interface FunctionCall {
	kind: 'call';
	name: Expr;
	args: Expr[];
}

export interface ArrayLiteral {
	kind: 'array';
	elements: Expr[];
}
export interface ObjectLiteral {
	kind: 'object';
	properties: { key: string; value: Expr }[];
}

export type Statement = VarDecl | FnDef | ReturnStmt | CallStmt | WhileLoop | ForInLoop | IfStmt | BreakStmt | ContinueStmt | TryStmt | ThrowStmt | ExprStmt;

export interface VarDecl {
	kind: 'var';
	name: string;
	value: Expr;
}

export interface FnDef {
	kind: 'fn';
	name: string;
	params: { name: string; type: string }[];
	body: Statement[];
}

export interface ReturnStmt {
	kind: 'return';
	value: Expr | null;
}
export interface CallStmt {
	kind: 'call';
	name: Expr;
	args: Expr[];
}
export interface IfStmt {
	kind: 'if';
	condition: Expr;
	thenBody: Statement[];
	elifs: { condition: Expr; body: Statement[] }[];
	elseBody: Statement[] | null;
}
export interface WhileLoop {
	kind: 'while';
	condition: Expr;
	body: Statement[];
}
export interface ForInLoop {
	kind: 'for';
	varName: string;
	iterable: Expr;
	body: Statement[];
}
export interface BreakStmt {
	kind: 'break';
}
export interface ContinueStmt {
	kind: 'continue';
}
export interface TryStmt {
	kind: 'try';
	body: Statement[];
	catchVar: string | null;
	catchBody: Statement[] | null;
}
export interface ThrowStmt {
	kind: 'throw';
	value: Expr;
}
export interface ExprStmt {
	kind: 'expr_stmt';
	expr: Expr;
}
