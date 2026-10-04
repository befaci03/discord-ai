// Shared error types. Everything user-facing goes through UserError;
// everything else is a bug and should not leak internals to users.
// Optional templates ([general].errors) let the operator reword the texts the
// bot shows: they only ever interpolate user-safe fragments (a service name,
// an already-sanitized inner message), never raw causes or stack traces.

export class AppError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AppError';
	}
}

/** Errors that are safe to show to Discord users. */
export class UserError extends AppError {
	constructor(message: string) {
		super(message);
		this.name = 'UserError';
	}
}

/** Thrown when input fails validation. Message is safe to display. */
export class ValidationError extends UserError {
	constructor(message: string) {
		super(message);
		this.name = 'ValidationError';
	}
}

/** Errors from third parties (Discord API, LLM providers). */
export class ExternalError extends AppError {
	/** which service failed: safe to show, unlike the underlying cause */
	public readonly service: string;

	constructor(service: string, cause: unknown) {
		super(`${service} error: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = 'ExternalError';
		this.service = service;
	}
}

/**
 * Operator-configurable wording for failures ([general].errors).
 * `{error}` and `{service}` are the only placeholders; anything else stays
 * literal, and raw internal error text is never substituted in.
 */
export interface ErrorTemplates {
	/** unexpected (non-user-safe) failures */
	generic: string;
	/** failed tool calls; `{error}` = the user-safe inner message */
	tool: string;
	/** third-party failures; `{service}` = the service name; "" = use generic */
	external: string;
	/** no usable LLM provider configured */
	provider: string;
}

export const DEFAULT_ERROR_TEMPLATES: ErrorTemplates = {
	generic: 'Something went wrong. The details are in the logs.',
	tool: 'tool error: {error}',
	external: '',
	provider: 'no LLM provider configured. Set [agent.providers] + [agent.models] in config.toml (and the API key env var).'
};

/** Hard cap for any rendered error text: Discord cuts messages at 2000. */
const RENDER_CAP = 2000;

/** Merge partial overrides onto the defaults, only accepting real strings. */
function withDefaults(over?: Partial<ErrorTemplates>): ErrorTemplates {
	if (!over) return DEFAULT_ERROR_TEMPLATES;
	return {
		generic: typeof over.generic === 'string' && over.generic.trim() ? over.generic : DEFAULT_ERROR_TEMPLATES.generic,
		tool: typeof over.tool === 'string' && over.tool.trim() ? over.tool : DEFAULT_ERROR_TEMPLATES.tool,
		external: typeof over.external === 'string' ? over.external : DEFAULT_ERROR_TEMPLATES.external,
		provider: typeof over.provider === 'string' && over.provider.trim() ? over.provider : DEFAULT_ERROR_TEMPLATES.provider
	};
}

/** Replace the known placeholders; unknown `{...}` tokens stay literal. */
function fill(tpl: string, vars: Record<string, string>): string {
	let out = tpl;
	for (const [key, value] of Object.entries(vars)) out = out.split(`{${key}}`).join(value);
	return out;
}

/**
 * Map any thrown value to a user-safe message.
 * UserError messages pass through (capped); everything else renders the
 * generic template, or the external one when a third party failed.
 */
export function toUserMessage(err: unknown, templates?: Partial<ErrorTemplates>): string {
	const t = withDefaults(templates);
	if (err instanceof UserError) return err.message.slice(0, RENDER_CAP);
	// the cause of an ExternalError is internal: only the service name shows
	if (err instanceof ExternalError && t.external.trim()) return fill(t.external, { service: err.service }).slice(0, RENDER_CAP);
	return t.generic.slice(0, RENDER_CAP);
}

/** Wording for a failed tool call: `{error}` = the user-safe inner message. */
export function toToolMessage(err: unknown, templates?: Partial<ErrorTemplates>): string {
	const t = withDefaults(templates);
	return fill(t.tool, { error: toUserMessage(err, t) }).slice(0, RENDER_CAP);
}

/** Wording shown when chat runs without a usable provider. */
export function noProviderMessage(templates?: Partial<ErrorTemplates>): string {
	return withDefaults(templates).provider.slice(0, RENDER_CAP);
}
