// Shared agent contract: what an Agent is, which tools/models it speaks about,
// and the Discord-shaped data it works with. The Brain (memory, tastes, people,
// model routing) lives in ./brain.js and is re-exported here, so existing
// `import { Brain } from "./struct.js"` callers keep working.

import { type Presence, type Role, type VoiceState, type PresenceStatus } from 'discord.js';
import { ChatCompletion } from 'openai/resources.mjs';

export { Brain, MEMORY_DEFAULT, looksLikeCode } from './brain.js';
export type { BrainSeed, ChatTurn, PersonSeed } from './brain.js';

export interface AskOptions {
	/** force a model type; when omitted, code-ish prompts route to the coding model */
	model?: ModelType;
	/** true = internal call (e.g. agent.generate_text): leave conversation memory alone */
	ephemeral?: boolean;
	/** numeric Discord id of the speaker: their saved profile is injected into the system prompt */
	speakerId?: string;
	/**
	 * Called once per tool round with the tool names the model is about to
	 * call (before they run), so the caller can show progress. Never throws
	 * into the loop: a broken hook is swallowed.
	 */
	onToolCall?: (toolNames: string[]) => void;
}

export interface Provider {
	apiType: 0 | 1; // 1 is openai-compatible, 0 is anthropic-compatible
	baseUrl: string;
	apiKey: string;
}

export type ModelType = 'default' | 'coding' | 'image' | 'video' | 'tts' | 'stt' | 'rerank';

export interface Model {
	type: ModelType;
	provider: Provider;
	name: string;
}

export interface ToolCallRequest {
	id: string;
	name: string;
	argumentsJson: string;
}

export interface ToolCallResult {
	toolCallId: string;
	content: string;
}

export default interface Agent {
	status: AgentStatus;
	/** optional: notified on every status change (the bot wires it to the dashboard) */
	onStatus?: ((status: AgentStatus) => void) | null;
	/** optional: runtime tool filter so toggled-off tools vanish from prompt + schema */
	toolFilter?: ((name: string) => boolean) | null;

	ask(prompt: string, system?: string, opts?: AskOptions): Promise<ChatCompletion>;
	useTool(tool: Tool, args: unknown): Promise<unknown>;
	getModel(type: ModelType): Model;
}

export interface Tool {
	name: string;
	description: string;
	/** JSON schema for the parameters object (OpenAI function format) */
	parameters?: Record<string, unknown>;
	invoker: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface AgentStatus {
	busy: boolean;
	doing: string | 'nothing much, just looking at messages';
	mode: 'talking' | 'coding' | 'idle';
}

export interface Message {
	readonly content: string;
	readonly timestamp: number;
	readonly author: Author;
}
export interface Author {
	readonly id: string;
	readonly username: string;
	readonly displayname: string;
	readonly createdSince: number; // timestamp, created his accounts since [.]
	readonly joinedSince: number; // timestamp, joined the discord server since [.]
	readonly lastActive: number; // timestamp, last sent message
	readonly roles: Role[];
	readonly presence: Presence;
	readonly voice: VoiceState;
	readonly oftenIn: PresenceStatus; // what status the author is often in (e.g. dnd)
	// Agent side
	data: AuthorCustomData;
	often: string[]; // what the agent thinks of what the author often do
}

export interface AuthorCustomData {
	description: string;
	likes: string[];
	dislikes: string[];
	personalities: string[];
}
