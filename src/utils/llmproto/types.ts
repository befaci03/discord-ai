/// TooLang reference helpers - shared types for tool definitions

/**
 * Argument definition for a tool.
 */
export interface ArgDef {
	type: "string" | "number" | "boolean";
	name: string;
	description: string;
	disallow: string[];
}

/**
 * Tool definition. Matches the JSON header in .tl files.
 */
export interface ToolDef {
	name: string;
	description: string;
	arguments: ArgDef[];
}
