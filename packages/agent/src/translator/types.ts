/** Evidence gathered while evaluating a semantic browser expectation. */
export interface BrowserExpectationEvidence {
	truth?: boolean;
	details: string[];
}

/**
 * Why a semantic wait stopped before proving the expectation.
 *
 * These reasons are part of the public wait contract surfaced to tool callers.
 */
export type BrowserWaitReason =
	| "navigation"
	| "dialog"
	| "target_changed"
	| "target_detached"
	| "stale_ref"
	| "observation_failed"
	| "incomplete_observation";

/**
 * Result payload for `browser_wait_for` reads.
 *
 * - `status` communicates terminal outcome (`satisfied`, `timed_out`,
 *   `unverifiable`, or `interrupted`).
 * - `evidence` clarifies whether success was preexisting/newly observed or
 *   whether failure is definitive/unverifiable.
 * - `initial`/`final` capture expectation evidence snapshots before and after
 *   polling.
 * - `reason` is present when the wait ended due to a specific interruption or
 *   unverifiable condition.
 */
export interface BrowserWaitForResult {
	status: "satisfied" | "timed_out" | "unverifiable" | "interrupted";
	evidence: "preexisting" | "newly_verified" | "failed" | "unverifiable";
	initial: BrowserExpectationEvidence;
	final: BrowserExpectationEvidence;
	elapsed_ms: number;
	reason?: BrowserWaitReason;
	details: string[];
}

export type BatchReadResult =
	| { type: "screenshot"; data: Buffer; mimeType: string }
	| { type: "url"; url: string }
	| { type: "cursor_position"; x: number; y: number }
	| { type: "browser_text"; label: string; text: string }
	| { type: "browser_wait_for"; result: BrowserWaitForResult };

export interface BatchExecutionResult {
	readResults: BatchReadResult[];
}
