/// TooLang reference helpers - shared types for tool definitions

/**
 * Argument definition for a tool.
 */
export interface ArgDef {
	type: 'string' | 'number' | 'boolean';
	name: string;
	description: string;
	disallow: string[];
	/** true = the caller may omit it: it arrives as the type's empty default ('' / 0 / false) */
	optional?: boolean;
}

/**
 * Tool definition. Matches the JSON header in .tl files.
 */
export interface ToolDef {
	name: string;
	description: string;
	arguments: ArgDef[];
}
