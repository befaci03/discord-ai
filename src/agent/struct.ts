import { type Presence, type Role, type VoiceState, type PresenceStatus } from "discord.js";
import DB from "../db/struct.js";
import { ChatCompletion } from "openai/resources.mjs";

type HistoryType = (Message | string)[]; // message or task
export class Brain {
	history: HistoryType = [];
	queue: Map<number, Message> = new Map(); // number is priority level
	lookingAt: Message | null = null;
	// data
	trust_factors: Map<string, number> = new Map(); // string is UID, number is between -3 and 2000
	dislikes: string[] = [];
	likes: string[] = [];
	favorites: string[] = []; // e.g. favorite prog lang, guy, etc.
	pending: string[] = []; // e.g. i need to improve the tic-tac-toe

	constructor(db: DB) {}
}

export interface Provider {
	apiType: 0 | 1; // 1 is openai-compatible, 0 is anthropic-compatible
	baseUrl: string;
	apiKey: string;
}

export type ModelType = "default" | "coding" | "image" | "video" | "tts" | "stt";

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

	ask(prompt: string, system?: string): Promise<ChatCompletion>;
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
	doing: string | "nothing much, just looking at messages";
	mode: "talking" | "coding" | "idle";
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
