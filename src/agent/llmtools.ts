// Model-type tools: each CONFIGURED model type becomes a callable tool, so
// the default model can delegate generation work and keep leading the
// conversation. Types without a configured model get NO tool: an
// always-failing tool is worse than none. The coding type is special: it
// never becomes a "generate" tool, it becomes llm_code (delegate a coding
// task, get the result, continue thinking as the master model).

import Agent, { Model, ModelType, Tool } from './struct.js';
import { rerankDocs } from '../utils/toolang/builtins/agent.js';

/** prompts handed straight to a media model are capped (chars) */
const PROMPT_CAP = 4_000;

/** Extract the text of a ChatCompletion-ish answer, capped. */
export function answerText(res: { choices?: { message?: { content?: unknown } }[] }): string {
	const raw = res.choices?.[0]?.message?.content;
	// gateways answer with a plain string OR content parts ([{ type, text }])
	const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((p) => (typeof p === 'string' ? p : String((p as { text?: unknown })?.text ?? ''))).join('') : '';
	return text.length > 0 ? text.slice(0, 16_000) : '(the model returned no text)';
}

/** One generic "generate X with the X model" tool. */
function genTool(agent: Agent, type: ModelType, name: string, description: string): Tool {
	return {
		name,
		description,
		parameters: {
			type: 'object',
			properties: { prompt: { type: 'string', description: 'what to generate, be specific' } },
			required: ['prompt']
		},
		invoker: async (args) => {
			const prompt = String(args.prompt ?? '').trim();
			if (prompt.length === 0 || prompt.length > PROMPT_CAP) throw new Error(`${name}: prompt must be 1..${PROMPT_CAP} chars`);
			const res = await agent.ask(prompt, undefined, { ephemeral: true, model: type });
			return answerText(res);
		}
	};
}

/**
 * Tools for the model types that are actually configured. `models` is the
 * list buildAgent resolved (dedicated entries only: use_same_models leaves
 * just the default, so nothing shows up there).
 */
export function llmTools(agent: Agent, models: Model[]): Tool[] {
	const has = (t: ModelType): boolean => models.some((m) => m.type === t);
	const out: Tool[] = [];

	if (has('image'))
		out.push(genTool(agent, 'image', 'llm_gen_image', 'Generate an IMAGE with the image model and return its answer (usually a URL). Use when the user asks for an image/picture/art.'));
	if (has('video')) out.push(genTool(agent, 'video', 'llm_gen_video', 'Generate a VIDEO with the video model and return its answer (usually a URL). Use when the user asks for a video/clip.'));
	if (has('tts')) out.push(genTool(agent, 'tts', 'llm_gen_audio', 'Turn text into SPEECH (text-to-speech) with the tts model and return its answer (usually a URL).'));
	if (has('stt')) {
		out.push({
			name: 'llm_transcribe',
			description: 'Transcribe an audio file (speech-to-text) with the stt model and return the text.',
			parameters: {
				type: 'object',
				properties: { audio_url: { type: 'string', description: 'https URL of the audio file' } },
				required: ['audio_url']
			},
			invoker: async (args) => {
				const url = String(args.audio_url ?? '').trim();
				if (!url.startsWith('https://') || url.length > 2_000) throw new Error('llm_transcribe: audio_url must be a https URL (max 2000 chars)');
				const res = await agent.ask(`Transcribe this audio: ${url}`, undefined, { ephemeral: true, model: 'stt' });
				return answerText(res);
			}
		});
	}
	if (has('rerank')) {
		out.push({
			name: 'llm_rerank',
			description: 'Rank documents against a query with the rerank model. Returns [{ index, score }] sorted best-first (index = position in YOUR array).',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'the query (1..4000 chars)' },
					documents: { type: 'array', items: { type: 'string' }, description: '1..100 documents to rank, max 4000 chars each' }
				},
				required: ['query', 'documents']
			},
			invoker: async (args) => await rerankDocs(agent, args.query, args.documents)
		});
	}
	if (has('coding')) {
		out.push({
			name: 'llm_code',
			description:
				'Delegate a coding task (write/review/debug/refactor code) to the dedicated CODING model. It runs out of conversation: you get its answer back and stay in charge. Give it the full task, it sees nothing else.',
			parameters: {
				type: 'object',
				properties: { task: { type: 'string', description: `the complete coding task (1..${PROMPT_CAP} chars), no context assumed` } },
				required: ['task']
			},
			invoker: async (args) => {
				const task = String(args.task ?? '').trim();
				if (task.length === 0 || task.length > PROMPT_CAP) throw new Error(`llm_code: task must be 1..${PROMPT_CAP} chars`);
				const res = await agent.ask(task, undefined, { ephemeral: true, model: 'coding' });
				return answerText(res);
			}
		});
	}
	return out;
}
