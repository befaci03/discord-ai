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
		generate_text: async (prompt: string) => {
			const agent = getAgent();
			if (typeof prompt !== "string" || prompt.length === 0) throw new AgentError("agent.generate_text expects a non-empty prompt");
			return await agent.ask(prompt);
		},

		generate_image: async (prompt: string) => {
			const agent = getAgent();
			requireModel(agent, "image");
			return await agent.ask(prompt);
		},

		generate_audio: async (prompt: string) => {
			const agent = getAgent();
			requireModel(agent, "tts");
			return await agent.ask(prompt);
		},

		generate_video: async (prompt: string) => {
			const agent = getAgent();
			requireModel(agent, "video");
			return await agent.ask(prompt);
		},

		transcript: async (audioUrl: string) => {
			const agent = getAgent();
			requireModel(agent, "stt");
			return await agent.ask(`Transcribe this audio: ${audioUrl}`);
		},
	};
}
