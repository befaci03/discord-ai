// Agent self-management: the `manage_tool` and `manage_skill` functions.
// Both are opt-in ([agent.toolang].allow_tool_creation / allow_skill_creation)
// and only registered when the flag is on, so a default install never offers
// them to the model.
//
// The actual work lives in manage_tool.ts / manage_skill.ts, the shared guards
// (names, directories, audit, write-rollback chain) in manage_shared.ts.

import type { Tool } from '../agent/struct.js';
import type { ManageDeps } from './manage_shared.js';
import { runManageTool } from './manage_tool.js';
import { runManageSkill } from './manage_skill.js';

export type { ManageDeps } from './manage_shared.js';

const ARG_DEF_SCHEMA = {
	type: 'object',
	properties: {
		name: { type: 'string', description: 'argument name (lowercase, used by the tool as args.<name>)' },
		type: { type: 'string', enum: ['string', 'number', 'boolean'], description: 'value type' },
		description: { type: 'string', description: 'what the argument means, the model reads it' }
	},
	required: ['name', 'type']
} as const;

/**
 * The agent-facing management tools, only when the operator turned them on.
 * Both are returned as regular Tools (like the brain tools), so they show up
 * in the tool inventory and are subject to the same schema/tool loop.
 */
export function managementTools(deps: ManageDeps): Tool[] {
	const out: Tool[] = [];
	if (deps.config.agent.toolang.allowToolCreation === true) {
		out.push({
			name: 'manage_tool',
			description:
				'Create, edit or delete one of YOUR .tl tools (the executable tools you call). create writes a validated file into the tool directory and registers it immediately; edit keeps fields you omit; delete removes it by name. ' +
				'Write only the program body, the JSON header + delimiter are generated for you. Every change is audited.',
			parameters: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['create', 'edit', 'delete'], description: 'what to do' },
					name: { type: 'string', description: "tool name, e.g. 'count_lines'" },
					description: { type: 'string', description: 'one-line summary shown in your tool list (required for create)' },
					arguments: {
						type: 'array',
						items: ARG_DEF_SCHEMA,
						description: "the tool's arguments; omit on edit to keep the current ones"
					},
					body: { type: 'string', description: "TooLang program body (after the ¤ delimiter), e.g. 'return(args.text)' " }
				},
				required: ['action', 'name']
			},
			invoker: async (args) => await runManageTool(deps, args)
		});
	}
	if (deps.config.agent.toolang.allowSkillCreation === true) {
		out.push({
			name: 'manage_skill',
			description:
				'Create, edit or delete one of YOUR markdown skills (instructions injected into your system prompt when a message hits a trigger). ' +
				"edit keeps fields you omit; delete removes it by name. The built-in 'toolang' skill is protected. Every change is audited.",
			parameters: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['create', 'edit', 'delete'], description: 'what to do' },
					name: { type: 'string', description: "skill name, e.g. 'regex_helper'" },
					description: { type: 'string', description: 'one-line summary (required for create)' },
					triggers: { type: 'string', description: "comma-separated words that activate the skill, e.g. 'regex, regular expression'" },
					instructions: { type: 'string', description: 'markdown body: what to do when the skill activates' },
					tools: { type: 'string', description: 'comma-separated tool names this skill recommends (optional)' },
					priority: { type: 'number', description: 'higher wins when several skills match (-100..100, default 0)' }
				},
				required: ['action', 'name']
			},
			invoker: async (args) => await runManageSkill(deps, args)
		});
	}
	return out;
}
