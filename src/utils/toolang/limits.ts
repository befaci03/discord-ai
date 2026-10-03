/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// Execution limits to keep TooLang tools from eating the machine alive

export interface InterpreterLimits {
	/** max iterations of a single while/for loop */
	maxLoopIterations: number;
	/** max recursion depth */
	maxCallDepth: number;
	/** max total statements evaluated per run */
	maxSteps: number;
	/** max length of a string the tool can build/return */
	maxOutputLength: number;
}

export const DEFAULT_LIMITS: InterpreterLimits = {
	maxLoopIterations: 10_000,
	maxCallDepth: 64,
	maxSteps: 200_000,
	maxOutputLength: 100_000,
};

/** Merge user-provided limits over defaults, clamping to sane minimums. */
export function resolveLimits(partial?: Partial<InterpreterLimits>): InterpreterLimits {
	const merged = { ...DEFAULT_LIMITS, ...(partial ?? {}) };
	return {
		maxLoopIterations: Math.max(10, Math.min(merged.maxLoopIterations, 1_000_000)),
		maxCallDepth: Math.max(2, Math.min(merged.maxCallDepth, 512)),
		maxSteps: Math.max(100, Math.min(merged.maxSteps, 10_000_000)),
		maxOutputLength: Math.max(100, Math.min(merged.maxOutputLength, 5_000_000)),
	};
}
