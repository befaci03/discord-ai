// Brain tools: let the model update its own tastes and the profiles it keeps
// about people. State lives in the DB kv store (namespace "brain"), so it
// survives restarts. Nothing here touches external systems.

import { Brain, Tool } from "./struct.js";

const ID_PROP = {
	type: "string",
	description: "numeric Discord user id (use the id you saw in the message, never a name)",
} as const;

const ID_RE = /^\d{5,30}$/;

/** Ids only: profiles are keyed by Discord user id, nothing else. */
function personId(raw: unknown): string {
	const id = String(raw ?? "").trim();
	if (!ID_RE.test(id)) throw new Error("brain: person_id must be a numeric Discord user id");
	return id;
}

/** Convert header args style (openai function schema) for a person patch. */
function personSchema(): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			person_id: ID_PROP,
			description: { type: "string", description: "one-line summary of who they are (optional)" },
			likes: { type: "string", description: "comma-separated things they like (optional)" },
			dislikes: { type: "string", description: "comma-separated things they dislike (optional)" },
			personalities: { type: "string", description: "comma-separated traits, e.g. \"loud, helpful\" (optional)" },
		},
		required: ["person_id"],
	};
}

export function brainTools(brain: Brain): Tool[] {
	return [
		{
			name: "brain_set_preference",
			description:
				"Update your OWN tastes (what you like/dislike/favorite) so your personality stays consistent across conversations. " +
				"use action 'neutral' to drop a target from every list. Call this only when the user asks you to, or when you genuinely change your mind.",
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["like", "dislike", "favorite", "neutral"], description: "what to do with the target" },
					target: { type: "string", description: "the thing itself, e.g. \"rust\", \"pineapple pizza\", \"Alice\"" },
				},
				required: ["action", "target"],
			},
			invoker: async (args) => await brain.setPreference(String(args.action ?? ""), args.target),
		},
		{
			name: "brain_remember_person",
			description:
				"Remember facts about a specific person (profile persists across restarts and is injected when they talk to you again). " +
				"Only call this with a real Discord user id from the current conversation.",
			parameters: personSchema(),
			invoker: async (args) => await brain.rememberPerson(personId(args.person_id), args),
		},
		{
			name: "brain_get_person",
			description: "Read back what you already know about a person before you claim to know nothing about them.",
			parameters: {
				type: "object",
				properties: { person_id: ID_PROP },
				required: ["person_id"],
			},
			invoker: async (args) => await brain.getPerson(personId(args.person_id)),
		},
	];
}
