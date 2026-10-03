// Shared error types. Everything user-facing goes through UserError;
// everything else is a bug and should not leak internals to users.

export class AppError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AppError";
	}
}

/** Errors that are safe to show to Discord users. */
export class UserError extends AppError {
	constructor(message: string) {
		super(message);
		this.name = "UserError";
	}
}

/** Thrown when input fails validation. Message is safe to display. */
export class ValidationError extends UserError {
	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
	}
}

/** Errors from third parties (Discord API, LLM providers). */
export class ExternalError extends AppError {
	constructor(service: string, cause: unknown) {
		super(`${service} error: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "ExternalError";
	}
}

/** Map any thrown value to a user-safe message. */
export function toUserMessage(err: unknown): string {
	if (err instanceof UserError) return err.message;
	return "Something went wrong. The details are in the logs.";
}
