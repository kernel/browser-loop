/** Three-valued semantic expectation result with model-facing evidence. */
export interface BrowserExpectationEvidence {
	truth?: boolean;
	details: string[];
}

/** Browser lifecycle or observation reason that terminated a semantic wait. */
export type BrowserWaitReason =
	| "navigation"
	| "dialog"
	| "target_changed"
	| "target_detached"
	| "stale_ref"
	| "observation_failed"
	| "incomplete_observation";

/** Structured result returned by the standalone `browser_wait_for` action. */
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
