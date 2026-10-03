// The "Executing ..." progress message: while the agent works through tool
// calls the bot posts one message in the channel, EDITS it on every following
// round, and deletes it right before the final reply is posted. Net result in
// the channel: question -> (working message) -> answer.
//
// Rules that matter:
// - the message never pings anyone (allowedMentions parse: [])
// - sends/edits/deletes are serialized and swallowed: a missing permission or
//   a rate limit must never break the actual answer
// - an empty template disables the feature entirely (nothing is ever sent)
// - rendered content is capped at Discord's 2000 char limit

export const NO_PINGS = { parse: [] as string[] } as const;
const CONTENT_CAP = 1_000;

export interface ExecChannelLike {
	send: (payload: { content: string; allowedMentions: { parse: string[] } }) => Promise<ExecMessageLike>;
}

export interface ExecMessageLike {
	edit: (content: string) => Promise<unknown>;
	delete: () => Promise<unknown>;
}

/**
 * Replace every [TOOL_NAME] with the list of tool names. The template itself
 * carries the formatting (the default wraps it in backticks and italics), so
 * this only inserts plain names.
 */
export function renderExecutionMessage(template: string, toolNames: string[]): string {
	const list = toolNames.filter(Boolean).join(', ') || '(unknown)';
	return template.split('[TOOL_NAME]').join(list).slice(0, CONTENT_CAP);
}

export class ExecutionStatus {
	private msg: ExecMessageLike | null = null;
	/** one chain: send -> edit -> edit ... never interleaved */
	private chain: Promise<unknown> = Promise.resolve();
	private ended = false;

	constructor(
		private channel: ExecChannelLike,
		/** already validated: single line, capped; empty = feature off */
		private template: string,
		private onError: (message: string) => void = () => undefined
	) {}

	get enabled(): boolean {
		return this.template.trim().length > 0;
	}

	/** One tool round: send on the first call, edit the same message after. */
	update(toolNames: string[]): void {
		if (!this.enabled || this.ended || toolNames.length === 0) return;
		const content = renderExecutionMessage(this.template, toolNames);
		this.chain = this.chain
			.then(async () => {
				if (this.ended) return; // already deleted while we were queued
				if (!this.msg) {
					this.msg = await this.channel.send({ content, allowedMentions: { parse: [] } });
				} else {
					await this.msg.edit(content);
				}
			})
			.catch((err: unknown) => this.onError(err instanceof Error ? err.message : String(err)));
	}

	/** Await the queued work, then delete the message (never throws). */
	async end(): Promise<void> {
		this.ended = true;
		await this.chain.catch(() => undefined);
		const msg = this.msg;
		this.msg = null;
		if (!msg) return;
		try {
			await msg.delete();
		} catch {
			/* already gone, or no manage-messages permission: the answer matters more */
		}
	}
}
