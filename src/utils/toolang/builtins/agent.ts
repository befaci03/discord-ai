/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// Agent module - wraps the Agent interface for TooLang

import type Agent from "../../../agent/struct.js";

class AgentError extends Error {
	constructor(message: string) {
		super(`Runtime error: ${message}`);
		this.name = "RuntimeError";
	}
}

export function Agent(getAgent: () => Agent): Record<string, Function> {
	const requireModel = (agent: Agent, type: "image" | "video" | "tts" | "stt") => {
		// throws if the model isn't configured, so tools fail loudly instead of silently
		agent.getModel(type);
	};
	return {
		// every call here is an internal generation: ephemeral keeps it out of the
		// rolling conversation memory, and the forced model type picks the right one
		generate_text: async (prompt: string) => {
			const agent = getAgent();
			if (typeof prompt !== "string" || prompt.length === 0) throw new AgentError("agent.generate_text expects a non-empty prompt");
			return await agent.ask(prompt, undefined, { ephemeral: true });
		},

		generate_image: async (prompt: string) => {
			const agent = getAgent();
			requireModel(agent, "image");
			return await agent.ask(prompt, undefined, { ephemeral: true, model: "image" });
		},

		generate_audio: async (prompt: string) => {
			const agent = getAgent();
			requireModel(agent, "tts");
			return await agent.ask(prompt, undefined, { ephemeral: true, model: "tts" });
		},

		generate_video: async (prompt: string) => {
			const agent = getAgent();
			requireModel(agent, "video");
			return await agent.ask(prompt, undefined, { ephemeral: true, model: "video" });
		},

		transcript: async (audioUrl: string) => {
			const agent = getAgent();
			requireModel(agent, "stt");
			return await agent.ask(`Transcribe this audio: ${audioUrl}`, undefined, { ephemeral: true, model: "stt" });
		},
	};
}
